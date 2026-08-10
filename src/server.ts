import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  APP_DEFINITIONS,
  normalizeToolResult,
  type AppDefinition,
  type AppId,
} from "./apps.js";
import { toolResultSchema, type ToolResult } from "./contracts.js";
import { asConnectionError } from "./errors.js";
import { ReadClient } from "./http.js";

function failure(app: AppDefinition, tool: string, error: unknown): ToolResult {
  const mapped = asConnectionError(error);
  return {
    schemaVersion: "1",
    ok: false,
    app: app.name,
    tool,
    generatedAt: new Date().toISOString(),
    retrievalMode: "error",
    hasMore: false,
    truncated: false,
    provenance: [],
    error: { code: mapped.code, message: mapped.message, retryable: mapped.retryable },
  };
}

export function buildServer(appId: AppId, fetchImpl?: typeof fetch): McpServer {
  const app = APP_DEFINITIONS[appId];
  const token = app.tokenEnv ? process.env[app.tokenEnv]?.trim() : undefined;
  const client = new ReadClient(app.operations, {
    baseUrl: process.env[app.baseUrlEnv]?.trim() || app.baseUrl,
    ...(token ? { token } : {}),
    ...(app.tokenPrefix ? { tokenPrefix: app.tokenPrefix } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const server = new McpServer(
    { name: app.serverName, version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: app.instructions },
  );

  for (const [toolName, tool] of Object.entries(app.tools)) {
    server.registerTool(
      toolName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: toolResultSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: tool.mode !== "owner-api",
        },
      },
      async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const response = await client.callWithMetadata(tool.operation, args);
          const normalized = normalizeToolResult({
            app,
            toolName,
            tool,
            payload: response.payload,
            args,
            sourceUrl: response.sourceUrl,
            ...(response.retrievalMode ? { retrievalMode: response.retrievalMode } : {}),
            ...(response.freshness ? { freshness: response.freshness } : {}),
          });
          const result = toolResultSchema.parse(normalized);
          const count = result.items?.length;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  count === undefined
                    ? `${app.name}: retrieved ${tool.title.toLocaleLowerCase()}.`
                    : `${app.name}: returned ${count} bounded result${count === 1 ? "" : "s"}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          const result = toolResultSchema.parse(failure(app, toolName, error));
          return {
            isError: true,
            content: [{ type: "text" as const, text: result.error!.message }],
            structuredContent: result,
          };
        }
      },
    );
  }

  return server;
}

export async function runServer(appId: AppId): Promise<void> {
  const server = buildServer(appId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

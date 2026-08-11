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

export interface ServerBuildOptions {
  fetchImpl?: typeof fetch;
  token?: string;
  baseUrl?: string;
  readProcessEnvironment?: boolean;
  securitySchemes?: readonly ToolSecurityScheme[];
}

export type ToolSecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes: readonly string[] };

export function buildServerForApp(
  app: AppDefinition,
  options: ServerBuildOptions = {},
): McpServer {
  const readProcessEnvironment = options.readProcessEnvironment ?? true;
  const environmentToken =
    readProcessEnvironment && app.tokenEnv ? process.env[app.tokenEnv]?.trim() : undefined;
  const environmentBaseUrl =
    readProcessEnvironment ? process.env[app.baseUrlEnv]?.trim() : undefined;
  const token = options.token?.trim() || environmentToken;
  const client = new ReadClient(app.operations, {
    baseUrl: options.baseUrl?.trim() || environmentBaseUrl || app.baseUrl,
    ...(token ? { token } : {}),
    ...(app.tokenPrefix ? { tokenPrefix: app.tokenPrefix } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
        _meta: {
          securitySchemes: options.securitySchemes ?? [{ type: "noauth" }],
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

export function buildServer(appId: AppId, fetchImpl?: typeof fetch): McpServer {
  return buildServerForApp(APP_DEFINITIONS[appId], {
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export async function runServer(appId: AppId): Promise<void> {
  const server = buildServer(appId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

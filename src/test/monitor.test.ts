import assert from "node:assert/strict";
import test from "node:test";

import { HOSTED_ROUTES, hostedRoute, oauthResource } from "../hosted.js";
import { PRODUCTION_AUTH0_ISSUER, runProductionMonitor } from "../monitor.js";

const protocolVersion = "2025-11-25";
const protectedPrefix = "/.well-known/oauth-protected-resource";

function responseJson(
  value: unknown,
  status = 200,
  noStore = true,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  if (noStore) headers.set("Cache-Control", "no-store");
  return Response.json(value, {
    status,
    headers,
  });
}

function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: PRODUCTION_AUTH0_ISSUER,
    authorization_endpoint: `${PRODUCTION_AUTH0_ISSUER}authorize`,
    token_endpoint: `${PRODUCTION_AUTH0_ISSUER}oauth/token`,
    registration_endpoint: `${PRODUCTION_AUTH0_ISSUER}oidc/register`,
    jwks_uri: `${PRODUCTION_AUTH0_ISSUER}.well-known/jwks.json`,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  };
}

const productionFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return responseJson({ ok: true, service: "fleet-chatgpt-connections" }, 200, false);
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return responseJson(authorizationServerMetadata());
  }
  if (url.pathname.startsWith(`${protectedPrefix}/`)) {
    const path = url.pathname.slice(protectedPrefix.length);
    const route = hostedRoute(path, url.hostname);
    if (!route || route.audience !== "personal") return responseJson({ error: "not_found" }, 404);
    return responseJson({
      resource: oauthResource(route, `${url.origin}${path}`),
      authorization_servers: [PRODUCTION_AUTH0_ISSUER],
      scopes_supported: [route.scope],
      bearer_methods_supported: ["header"],
    });
  }
  const route = hostedRoute(url.pathname, url.hostname);
  if (!route) return responseJson({ error: "not_found" }, 404);
  if (route.audience === "personal") {
    const resourceMetadata = `${url.origin}${protectedPrefix}${url.pathname}`;
    return responseJson({ jsonrpc: "2.0", error: { code: -32000 }, id: null }, 401, true, {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}", scope="${route.scope}"`,
    });
  }
  const message = await request.json() as { id: number; method: string; params?: Record<string, unknown> };
  if (message.method === "initialize") {
    return responseJson({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: route.app.serverName, version: "0.1.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return responseJson({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: Object.keys(route.app.tools).map((name) => ({
          name,
          annotations: { readOnlyHint: true, destructiveHint: false },
          securitySchemes: [{ type: "noauth" }],
        })),
      },
    });
  }
  const params = message.params ?? {};
  const name = typeof params.name === "string" ? params.name : "";
  if (name.startsWith("delete_")) {
    return responseJson({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: true, content: [{ type: "text", text: "tool not found" }] },
    });
  }
  return responseJson({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      structuredContent: {
        schemaVersion: "1",
        ok: true,
        tool: name,
        items: [{ password: "must-never-enter-receipt" }],
        truncated: false,
      },
    },
  });
};

test("production monitor retains only redacted contract evidence", async () => {
  const receipt = await runProductionMonitor({
    fetchImpl: productionFetch,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.summary, { passed: 39, failed: 0, total: 39 });
  assert.equal(receipt.checkedAt, "2026-08-12T00:00:00.000Z");
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("must-never-enter-receipt"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(receipt.checks.filter(({ id }) => id === "representative-read").length, 4);
  assert.equal(receipt.checks.filter(({ id }) => id === "oauth-resource").length, 3);
  assert.equal(receipt.checks.filter(({ id }) => id === "host-isolation").length, 7);
});

test("production monitor reports stable failures without retaining response bodies", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === HOSTED_ROUTES["/starboard/mcp"]!.hosts[0] && url.pathname === "/health") {
      return new Response("upstream secret body", { status: 503 });
    }
    return productionFetch(input, init);
  };
  const receipt = await runProductionMonitor({ fetchImpl });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.summary.failed, 1);
  const failure = receipt.checks.find(({ plugin, id }) => plugin === "starboard" && id === "health");
  assert.deepEqual(failure, {
    id: "health",
    plugin: "starboard",
    status: "failed",
    errorCode: "health_status_invalid",
  });
  assert.equal(JSON.stringify(receipt).includes("upstream secret body"), false);
});

test("production monitor requires exact public tool-catalog parity", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === HOSTED_ROUTES["/starboard/mcp"]!.hosts[0] && request.method === "POST") {
      const message = await request.clone().json() as { id: number; method: string };
      if (message.method === "tools/list") {
        return responseJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: "search_repositories",
              annotations: { readOnlyHint: true, destructiveHint: false },
              securitySchemes: [{ type: "noauth" }],
            }],
          },
        });
      }
    }
    return productionFetch(request);
  };
  const receipt = await runProductionMonitor({ fetchImpl });
  const failure = receipt.checks.find(({ plugin, id }) => plugin === "starboard" && id === "tools-readonly");
  assert.equal(failure?.errorCode, "tool_catalog_parity_invalid");
});

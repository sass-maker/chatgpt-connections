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
  if (route.audience === "personal" && !request.headers.has("authorization")) {
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
        serverInfo: { name: route.kind === "adapter" ? route.app.serverName : route.serverName, version: "0.1.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return responseJson({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: (route.kind === "adapter" ? Object.keys(route.app.tools) : [...(route.allowedTools ?? [])]).map((name) => ({
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
  const toolArguments = params.arguments && typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const requestedLimit = typeof toolArguments.pagesize === "number"
    ? toolArguments.pagesize
    : typeof toolArguments.limit === "number"
      ? toolArguments.limit
      : 1;
  const requestedOffset = typeof toolArguments.offset === "number" ? toolArguments.offset : 0;
  const total = 10;
  const items = Array.from(
    { length: Math.max(0, Math.min(requestedLimit, total - requestedOffset)) },
    (_, index) => ({ id: `${route.id}-${requestedOffset + index}` }),
  );
  const nextOffset = requestedOffset + items.length < total
    ? requestedOffset + items.length
    : null;
  return responseJson({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      structuredContent: {
        schemaVersion: "1",
        ok: true,
        tool: name,
        ...(route.id === "anime-list-public" || route.id === "anime-list"
          ? { data: { filteredList: items, totalFiltered: total } }
          : { items, total, nextOffset, hasMore: nextOffset !== null }),
        truncated: nextOffset !== null,
      },
    },
  });
};

test("production monitor retains only redacted contract evidence", async () => {
  const receipt = await runProductionMonitor({
    fetchImpl: productionFetch,
    includePrepared: true,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.summary, { passed: 70, failed: 0, skipped: 0, total: 70 });
  assert.equal(receipt.checkedAt, "2026-08-12T00:00:00.000Z");
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("must-never-enter-receipt"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(receipt.checks.filter(({ id }) => id === "representative-read").length, 8);
  assert.equal(receipt.checks.filter(({ id }) => id === "pagination").length, 7);
  assert.equal(receipt.checks.filter(({ id }) => id === "oauth-resource").length, 3);
  assert.equal(receipt.checks.filter(({ id }) => id === "host-isolation").length, 11);
});

test("production monitor excludes prepared routes until activation", async () => {
  const receipt = await runProductionMonitor({ fetchImpl: productionFetch });
  assert.deepEqual(receipt.summary, { passed: 43, failed: 0, skipped: 0, total: 43 });
  assert.equal(receipt.checks.filter(({ id }) => id === "representative-read").length, 4);
  assert.equal(receipt.checks.filter(({ id }) => id === "pagination").length, 4);
  assert.equal(receipt.checks.filter(({ id }) => id === "host-isolation").length, 7);
});

test("production monitor can verify private collection pagination without retaining bearers", async () => {
  const receipt = await runProductionMonitor({
    fetchImpl: productionFetch,
    personalAuthorizations: {
      reader: "Bearer reader-private-monitor-secret",
      calorie: "Bearer calorie-private-monitor-secret",
      "anime-list": "Bearer anime-private-monitor-secret",
    },
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.summary, { passed: 46, failed: 0, skipped: 0, total: 46 });
  assert.equal(receipt.checks.filter(({ id }) => id === "authenticated-pagination").length, 3);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("private-monitor-secret"), false);
  assert.equal(serialized.includes("Bearer"), false);
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

/**
 * Serves Significant Hobbies' pagination tool from a dataset of `total` items,
 * honouring limit/offset exactly. Every other route keeps the normal stub.
 */
function smallDatasetFetch(total: number): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === HOSTED_ROUTES["/significant-hobbies/mcp"]!.hosts[0] && request.method === "POST") {
      const message = await request.clone().json() as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: { limit?: number; offset?: number } };
      };
      if (message.method === "tools/call" && message.params?.name === "search_public_timelines") {
        const offset = message.params.arguments?.offset ?? 0;
        const limit = message.params.arguments?.limit ?? 2;
        const items = Array.from(
          { length: Math.max(0, Math.min(limit, total - offset)) },
          (_, index) => ({ id: `timeline-${offset + index}` }),
        );
        const nextOffset = offset + items.length < total ? offset + items.length : null;
        return responseJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              schemaVersion: "1",
              ok: true,
              tool: "search_public_timelines",
              items,
              total,
              nextOffset,
              hasMore: nextOffset !== null,
              truncated: nextOffset !== null,
            },
          },
        });
      }
    }
    return productionFetch(request);
  };
}

test("a live dataset too small for three pages skips pagination instead of failing", async () => {
  const receipt = await runProductionMonitor({ fetchImpl: smallDatasetFetch(3) });
  const check = receipt.checks.find(
    ({ plugin, id }) => plugin === "significant-hobbies" && id === "pagination",
  );
  assert.deepEqual(check, {
    id: "pagination",
    plugin: "significant-hobbies",
    status: "skipped",
    skipReason: "pagination_dataset_too_small",
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.summary, { passed: 42, failed: 0, skipped: 1, total: 43 });
});

test("an empty live dataset skips pagination instead of failing", async () => {
  const receipt = await runProductionMonitor({ fetchImpl: smallDatasetFetch(0) });
  const check = receipt.checks.find(
    ({ plugin, id }) => plugin === "significant-hobbies" && id === "pagination",
  );
  assert.equal(check?.status, "skipped");
  assert.equal(check?.skipReason, "pagination_dataset_too_small");
  assert.equal(receipt.ok, true);
});

test("a broken pagination call still fails even though small datasets skip", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === HOSTED_ROUTES["/significant-hobbies/mcp"]!.hosts[0] && request.method === "POST") {
      const message = await request.clone().json() as {
        id: number;
        method: string;
        params?: { name?: string };
      };
      if (message.method === "tools/call" && message.params?.name === "search_public_timelines") {
        return responseJson({
          jsonrpc: "2.0",
          id: message.id,
          result: { isError: true, content: [{ type: "text", text: "upstream unavailable" }] },
        });
      }
    }
    return productionFetch(request);
  };
  const receipt = await runProductionMonitor({ fetchImpl });
  const failure = receipt.checks.find(
    ({ plugin, id }) => plugin === "significant-hobbies" && id === "pagination",
  );
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.errorCode, "pagination_call_failed");
  assert.equal(receipt.ok, false);
});

test("a large dataset that ignores the limit argument still fails", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === HOSTED_ROUTES["/significant-hobbies/mcp"]!.hosts[0] && request.method === "POST") {
      const message = await request.clone().json() as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: { limit?: number; offset?: number } };
      };
      if (message.method === "tools/call" && message.params?.name === "search_public_timelines") {
        const offset = message.params.arguments?.offset ?? 0;
        return responseJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              schemaVersion: "1",
              ok: true,
              tool: "search_public_timelines",
              // Ignores `limit` and returns a single item per page.
              items: [{ id: `timeline-${offset}` }],
              total: 10,
              nextOffset: offset + 1,
              hasMore: true,
              truncated: true,
            },
          },
        });
      }
    }
    return productionFetch(request);
  };
  const receipt = await runProductionMonitor({ fetchImpl });
  const failure = receipt.checks.find(
    ({ plugin, id }) => plugin === "significant-hobbies" && id === "pagination",
  );
  assert.equal(failure?.status, "failed");
  assert.equal(failure?.errorCode, "pagination_page_size_invalid");
  assert.equal(receipt.ok, false);
});

test("production monitor rejects pagination totals that change between pages", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === HOSTED_ROUTES["/significant-hobbies/mcp"]!.hosts[0] && request.method === "POST") {
      const message = await request.clone().json() as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: { limit?: number; offset?: number } };
      };
      if (message.method === "tools/call" && message.params?.name === "search_public_timelines") {
        const offset = message.params.arguments?.offset ?? 0;
        const limit = message.params.arguments?.limit ?? 2;
        const total = offset === 0 ? 10 : 10 + offset;
        return responseJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              schemaVersion: "1",
              ok: true,
              tool: "search_public_timelines",
              items: Array.from({ length: limit }, (_, index) => ({ id: `timeline-${offset + index}` })),
              total,
              nextOffset: offset + limit < total ? offset + limit : null,
              hasMore: offset + limit < total,
              truncated: offset + limit < total,
            },
          },
        });
      }
    }
    return productionFetch(request);
  };
  const receipt = await runProductionMonitor({ fetchImpl });
  const failure = receipt.checks.find(
    ({ plugin, id }) => plugin === "significant-hobbies" && id === "pagination",
  );
  assert.equal(failure?.errorCode, "pagination_total_unstable");
});

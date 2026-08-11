import assert from "node:assert/strict";
import test from "node:test";

import { HOSTED_ROUTES, type HostedRouteDefinition } from "../hosted.js";
import type { OAuthGrantProps } from "../oauth.js";
import { handleHostedRequest } from "../worker.js";

const protocolVersion = "2025-11-25";

function requestFor(
  path: string,
  body: unknown,
  options: {
    authorization?: string | undefined;
    origin?: string | undefined;
    protocol?: string | undefined;
  } = {},
): Request {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": options.protocol ?? protocolVersion,
  });
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.origin) headers.set("Origin", options.origin);
  return new Request(`https://mcp.example${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function initializeRequest(id = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "worker-test", version: "1.0.0" },
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function productToken(route: HostedRouteDefinition): string {
  switch (route.id) {
    case "reader": return "rdr_worker-secret";
    case "calorie": return "calorie_read_worker-secret";
    case "setline": return "setline_read_worker-secret";
    case "anime-list": return "anime_list_worker-secret";
    default: throw new Error("public routes do not have product tokens");
  }
}

function authorizationFor(path: string, overrides: Partial<OAuthGrantProps> = {}) {
  const route = HOSTED_ROUTES[path]!;
  assert.equal(route.audience, "personal");
  return {
    grant: {
      ownerId: "owner-subject",
      product: route.id,
      resource: `https://mcp.example${path}`,
      scope: route.scope!,
      ...overrides,
    },
    productToken: productToken(route),
  };
}

async function nativeMcpResponse(request: Request): Promise<Response> {
  const message = await request.clone().json() as { id?: number; method?: string };
  if (message.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "anime-list-by-significant-hobbies", version: "1.0.0" },
      },
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      tools: [
        {
          name: "list_watchlist",
          description: "Read the owner's watchlist.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    },
  });
}

const routeFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.url === "https://anime.significanthobbies.com/api/mcp") {
    return nativeMcpResponse(request);
  }
  return Response.json({ items: [] });
};

test("hosted route registry is fixed and public Research Papers exposes only exports", () => {
  assert.deepEqual(Object.keys(HOSTED_ROUTES), [
    "/reader/mcp",
    "/calorie/mcp",
    "/setline/mcp",
    "/anime-list/mcp",
    "/starboard/mcp",
    "/high-signal/mcp",
    "/significant-hobbies/mcp",
    "/research-papers/mcp",
  ]);
  const papers = HOSTED_ROUTES["/research-papers/mcp"]!;
  assert.equal(papers.kind, "adapter");
  if (papers.kind !== "adapter") throw new Error("expected adapter route");
  assert.deepEqual(Object.keys(papers.app.tools), [
    "list_hot_papers",
    "list_sleepers",
    "get_reading_path",
  ]);
  assert.deepEqual(Object.keys(papers.app.operations), ["hot", "sleepers", "path"]);
});

for (const [path, route] of Object.entries(HOSTED_ROUTES)) {
  test(`${path} initializes with only its product identity`, async () => {
    const authorization = route.audience === "personal" ? authorizationFor(path) : undefined;
    const response = await handleHostedRequest(
      requestFor(path, initializeRequest()),
      routeFetch,
      authorization,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await json(response);
    const result = payload.result as Record<string, unknown>;
    const serverInfo = result.serverInfo as Record<string, unknown>;
    const expectedName = route.kind === "adapter" ? route.app.serverName : route.serverName;
    assert.equal(serverInfo.name, expectedName);
    assert.equal(JSON.stringify(payload).includes("worker-secret"), false);
  });

  test(`${path} advertises its exact read-only security scheme`, async () => {
    const authorization = route.audience === "personal" ? authorizationFor(path) : undefined;
    const response = await handleHostedRequest(
      requestFor(path, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      routeFetch,
      authorization,
    );
    assert.equal(response.status, 200);
    const payload = await json(response);
    const result = payload.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      const annotations = tool.annotations as Record<string, unknown>;
      assert.equal(annotations.readOnlyHint, true);
      assert.equal(annotations.destructiveHint, false);
      const expected = route.audience === "personal"
        ? [{ type: "oauth2", scopes: [route.scope] }]
        : [{ type: "noauth" }];
      assert.deepEqual(tool.securitySchemes, expected);
      assert.deepEqual((tool._meta as Record<string, unknown>).securitySchemes, expected);
    }
  });
}

test("private routes reject direct product PATs and emit an OAuth challenge", async () => {
  let called = false;
  const response = await handleHostedRequest(
    requestFor("/reader/mcp", initializeRequest(), { authorization: "Bearer rdr_direct-pat" }),
    async () => {
      called = true;
      return Response.json({ items: [] });
    },
  );
  assert.equal(response.status, 401);
  assert.equal(called, false);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /oauth-protected-resource\/reader\/mcp/u);
  assert.match(challenge, /scope="reader\.read"/u);
  assert.equal(challenge.includes("rdr_direct-pat"), false);
});

test("OAuth grants are bound to one exact product, scope, and resource", async () => {
  const wrongProduct = await handleHostedRequest(
    requestFor("/reader/mcp", initializeRequest()),
    routeFetch,
    authorizationFor("/reader/mcp", { product: "calorie" }),
  );
  const wrongScope = await handleHostedRequest(
    requestFor("/reader/mcp", initializeRequest()),
    routeFetch,
    authorizationFor("/reader/mcp", { scope: "calorie.read" }),
  );
  const wrongResource = await handleHostedRequest(
    requestFor("/reader/mcp", initializeRequest()),
    routeFetch,
    authorizationFor("/reader/mcp", { resource: "https://mcp.example/calorie/mcp" }),
  );
  assert.deepEqual([wrongProduct.status, wrongScope.status, wrongResource.status], [401, 401, 401]);
});

test("private product secrets remain isolated under concurrent OAuth calls", async () => {
  const seen: Array<{ authorization: string | null; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const url = String(input);
    seen.push({ authorization, url });
    await Promise.resolve();
    return Response.json({
      items: [{ title: authorization?.startsWith("Bearer rdr_") ? "reader-result" : "calorie-result" }],
    });
  };
  const readerCall = {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "search_saved_reading", arguments: { q: "safe", limit: 1, offset: 0 } },
  };
  const calorieCall = {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "search_saved_foods", arguments: { q: "safe", status: "active", limit: 1, offset: 0 } },
  };
  const [reader, calorie] = await Promise.all([
    handleHostedRequest(
      requestFor("/reader/mcp", readerCall, { authorization: "Bearer oauth-reader" }),
      fetchImpl,
      authorizationFor("/reader/mcp"),
    ),
    handleHostedRequest(
      requestFor("/calorie/mcp", calorieCall, { authorization: "Bearer oauth-calorie" }),
      fetchImpl,
      authorizationFor("/calorie/mcp"),
    ),
  ]);
  const bodies = [JSON.stringify(await json(reader)), JSON.stringify(await json(calorie))];
  assert.deepEqual(new Set(seen.map((item) => item.authorization)), new Set([
    "Bearer rdr_worker-secret",
    "Bearer calorie_read_worker-secret",
  ]));
  assert.equal(bodies[0]!.includes("reader-result"), true);
  assert.equal(bodies[0]!.includes("calorie-result"), false);
  assert.equal(bodies[1]!.includes("calorie-result"), true);
  assert.equal(bodies[1]!.includes("reader-result"), false);
  assert.equal(bodies.some((body) => body.includes("worker-secret") || body.includes("oauth-")), false);
});

test("Anime List proxy fixes the upstream URL and replaces the OAuth bearer with its Worker secret", async () => {
  const calls: Array<{ url: string; authorization: string | null; method: string }> = [];
  const response = await handleHostedRequest(
    requestFor("/anime-list/mcp", initializeRequest(), { authorization: "Bearer oauth-chatgpt" }),
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        method: request.method,
      });
      return nativeMcpResponse(request);
    },
    authorizationFor("/anime-list/mcp"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    url: "https://anime.significanthobbies.com/api/mcp",
    authorization: "Bearer anime_list_worker-secret",
    method: "POST",
  }]);
  assert.equal(JSON.stringify(await json(response)).includes("oauth-chatgpt"), false);
});

test("public routes reject credentials and use anonymous upstream reads", async () => {
  const rejected = await handleHostedRequest(
    requestFor("/starboard/mcp", initializeRequest(), { authorization: "Bearer accidental" }),
  );
  assert.equal(rejected.status, 401);

  const calls: Array<{ url: string; authorization: string | null }> = [];
  const response = await handleHostedRequest(
    requestFor("/research-papers/mcp", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_hot_papers", arguments: { limit: 1, offset: 0 } },
    }),
    async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json([{ paper_id: "arxiv:one", source: "arxiv" }], {
        headers: { "Last-Modified": "Tue, 11 Aug 2026 00:00:00 GMT" },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    url: "https://papers.highsignal.app/data/hot.json",
    authorization: null,
  }]);
  const body = JSON.stringify(await json(response));
  assert.equal(body.includes("public-static"), true);
  assert.equal(body.includes("Tue, 11 Aug 2026 00:00:00 GMT"), true);
});

test("protocol boundary rejects unsupported routes, origins, methods, and oversized bodies", async () => {
  const unknown = await handleHostedRequest(requestFor("/unknown/mcp", initializeRequest()));
  assert.equal(unknown.status, 404);

  const badOrigin = await handleHostedRequest(
    requestFor("/starboard/mcp", initializeRequest(), { origin: "https://evil.example" }),
  );
  assert.equal(badOrigin.status, 403);

  const get = await handleHostedRequest(new Request("https://mcp.example/starboard/mcp"));
  assert.equal(get.status, 405);

  const oversized = await handleHostedRequest(
    new Request("https://mcp.example/starboard/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(256_001) }),
    }),
  );
  assert.equal(oversized.status, 413);
});

test("native proxy rejects an oversized streamed upstream response", async () => {
  const chunk = new Uint8Array(600_000);
  const response = await handleHostedRequest(
    requestFor("/anime-list/mcp", initializeRequest()),
    async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), {
      headers: { "Content-Type": "application/json" },
    }),
    authorizationFor("/anime-list/mcp"),
  );
  assert.equal(response.status, 502);
  assert.match(JSON.stringify(await json(response)), /exceeded the size limit/u);
});

test("invalid JSON-RPC remains a bounded protocol error", async () => {
  const response = await handleHostedRequest(
    requestFor("/starboard/mcp", { jsonrpc: "2.0", id: 6, method: "unknown", params: {} }),
  );
  assert.equal(response.status, 200);
  const text = JSON.stringify(await json(response));
  assert.equal(text.includes("Method not found"), true);
  assert.equal(text.length < 10_000, true);
});

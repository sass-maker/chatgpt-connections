import assert from "node:assert/strict";
import test from "node:test";

import { HOSTED_ROUTES, oauthResource, type HostedRouteDefinition } from "../hosted.js";
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

function upstreamToken(route: HostedRouteDefinition): string {
  if (route.id === "setline") return "setline_read_worker-secret";
  return `${route.id.replaceAll("-", "")}Header.oauthPayload.oauthSignature`;
}

function authorizationFor(path: string, overrides: Partial<OAuthGrantProps> = {}) {
  const route = HOSTED_ROUTES[path]!;
  assert.equal(route.audience, "personal");
  return {
    grant: {
      subject: "google-oauth2|owner-subject",
      product: route.id,
      resource: oauthResource(route, `https://mcp.example${path}`),
      scope: route.scope!,
      ...overrides,
    },
    upstreamToken: upstreamToken(route),
  };
}

async function nativeMcpResponse(request: Request): Promise<Response> {
  const message = await request.clone().json() as { id?: number; method?: string; params?: { name?: string } };
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
  if (message.method === "tools/call") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        structuredContent: { schemaVersion: "1", ok: true, tool: message.params?.name, items: [{ mal_id: 1 }] },
      },
    });
  }
  const publicTools = [
    "search_anime", "search_manga", "get_anime_detail", "get_manga_detail",
    "get_anime_stats", "get_random_anime",
  ];
  const personalTools = [
    "list_watchlist", "list_manga_watchlist", "list_watchlist_tags", "get_watchlist_enriched",
  ];
  return Response.json({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      tools: [...publicTools, ...personalTools].map((name) => ({
          name,
          description: "Read Anime List data.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        })),
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
    "/anime-list-public/mcp",
    "/starboard/mcp",
    "/high-signal/mcp",
    "/significant-hobbies/mcp",
    "/research-papers/mcp",
    "/swe-interview-prep/mcp",
    "/saas-maker/mcp",
    "/drank/mcp",
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

test("an unavailable owner-token product credential fails closed before upstream", async () => {
  let called = false;
  const response = await handleHostedRequest(
    requestFor("/setline/mcp", initializeRequest()),
    async () => {
      called = true;
      return Response.json({ items: [] });
    },
    { ...authorizationFor("/setline/mcp"), upstreamToken: undefined },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "300");
  assert.equal(called, false);
  assert.match(JSON.stringify(await json(response)), /temporarily unavailable/u);
});

test("private OAuth tokens remain isolated under concurrent calls and propagate end to end", async () => {
  const seen: Array<{ authorization: string | null; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const url = String(input);
    seen.push({ authorization, url });
    await Promise.resolve();
    return Response.json({
      items: [{ title: authorization?.includes("readerHeader") ? "reader-result" : "calorie-result" }],
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
    "Bearer readerHeader.oauthPayload.oauthSignature",
    "Bearer calorieHeader.oauthPayload.oauthSignature",
  ]));
  assert.equal(bodies[0]!.includes("reader-result"), true);
  assert.equal(bodies[0]!.includes("calorie-result"), false);
  assert.equal(bodies[1]!.includes("calorie-result"), true);
  assert.equal(bodies[1]!.includes("reader-result"), false);
  assert.equal(bodies.some((body) => body.includes("oauthPayload") || body.includes("oauth-")), false);
});

test("Anime List proxy fixes the upstream URL and forwards the verified OAuth bearer", async () => {
  const calls: Array<{ url: string; authorization: string | null; method: string; redirect: RequestRedirect }> = [];
  const response = await handleHostedRequest(
    requestFor("/anime-list/mcp", initializeRequest(), { authorization: "Bearer oauth-chatgpt" }),
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        method: request.method,
        redirect: request.redirect,
      });
      return nativeMcpResponse(request);
    },
    authorizationFor("/anime-list/mcp"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    url: "https://anime.significanthobbies.com/api/mcp",
    authorization: "Bearer animelistHeader.oauthPayload.oauthSignature",
    method: "POST",
    redirect: "manual",
  }]);
  assert.equal(JSON.stringify(await json(response)).includes("oauth-chatgpt"), false);
});

test("public Anime List exposes only catalog tools and rejects personal calls before upstream", async () => {
  const listed = await handleHostedRequest(
    requestFor("/anime-list-public/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    routeFetch,
  );
  assert.equal(listed.status, 200);
  const listedPayload = await json(listed);
  const tools = ((listedPayload.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
  assert.deepEqual(tools.map(({ name }) => name), [
    "search_anime", "search_manga", "get_anime_detail", "get_manga_detail",
    "get_anime_stats", "get_random_anime",
  ]);
  assert.equal(tools.every((tool) => JSON.stringify(tool.securitySchemes) === JSON.stringify([{ type: "noauth" }])), true);

  let forwarded = false;
  const rejected = await handleHostedRequest(
    requestFor("/anime-list-public/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_watchlist", arguments: {} },
    }),
    async () => {
      forwarded = true;
      return Response.json({});
    },
  );
  assert.equal(rejected.status, 200);
  assert.equal(forwarded, false);
  assert.equal(((await json(rejected)).result as Record<string, unknown>).isError, true);

  const methodRejected = await handleHostedRequest(
    requestFor("/anime-list-public/mcp", { jsonrpc: "2.0", id: 5, method: "resources/list", params: {} }),
    async () => {
      forwarded = true;
      return Response.json({});
    },
  );
  assert.equal(methodRejected.status, 200);
  assert.equal(forwarded, false);
  assert.equal((await json(methodRejected)).error instanceof Object, true);
});

test("public Anime List fails closed if its native catalog cannot be filtered", async () => {
  const response = await handleHostedRequest(
    requestFor("/anime-list-public/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    async () => new Response("event: message\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  assert.equal(response.status, 502);
  assert.match(JSON.stringify(await json(response)), /cannot be safely filtered/u);
});

test("public Anime List forwards catalog calls anonymously and uses its own identity", async () => {
  const calls: Array<{ authorization: string | null; method: string | undefined }> = [];
  const initialized = await handleHostedRequest(
    requestFor("/anime-list-public/mcp", initializeRequest()),
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        authorization: request.headers.get("authorization"),
        method: (await request.clone().json() as { method?: string }).method,
      });
      return nativeMcpResponse(request);
    },
  );
  const initializedPayload = await json(initialized);
  const serverInfo = ((initializedPayload.result as Record<string, unknown>).serverInfo as Record<string, unknown>);
  assert.equal(serverInfo.name, "anime-list-public-by-significant-hobbies");

  await handleHostedRequest(
    requestFor("/anime-list-public/mcp", {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_anime", arguments: { pagesize: 1 } },
    }),
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        authorization: request.headers.get("authorization"),
        method: (await request.clone().json() as { method?: string }).method,
      });
      return nativeMcpResponse(request);
    },
  );
  assert.deepEqual(calls, [
    { authorization: null, method: "initialize" },
    { authorization: null, method: "tools/call" },
  ]);
});

test("branded hosts expose only their assigned plugin routes", async () => {
  const allowed = await handleHostedRequest(
    new Request("https://mcp.highsignal.app/high-signal/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest()),
    }),
  );
  const isolated = await handleHostedRequest(
    new Request("https://mcp.highsignal.app/starboard/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest()),
    }),
  );
  assert.equal(allowed.status, 200);
  assert.equal(isolated.status, 404);
});

test("Anime List proxy rejects upstream redirects without forwarding them", async () => {
  const response = await handleHostedRequest(
    requestFor("/anime-list/mcp", initializeRequest()),
    async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }),
    authorizationFor("/anime-list/mcp"),
  );

  assert.equal(response.status, 502);
  assert.equal(response.headers.has("location"), false);
  assert.match(JSON.stringify(await json(response)), /redirects are not allowed/u);
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

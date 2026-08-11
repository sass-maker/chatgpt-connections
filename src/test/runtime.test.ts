import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { APP_DEFINITIONS, type AppId, normalizeToolResult } from "../apps.js";
import { ConnectionError } from "../errors.js";
import { ReadClient } from "../http.js";
import { sanitize, sanitizationTruncated } from "../sanitize.js";
import { buildServer } from "../server.js";

test("all shared connections expose only fixed relative GET operations", () => {
  for (const app of Object.values(APP_DEFINITIONS)) {
    for (const [name, operation] of Object.entries(app.operations)) {
      const path = operation.path({
        id: "safe-id",
        slug: "safe-slug",
        q: "query",
        url: "https://github.com/openai/openai-node",
        limit: 10,
        offset: 0,
      });
      assert.match(path, /^\/(?!\/)/, `${app.id}:${name}`);
      assert.equal(path.includes("Authorization"), false);
      assert.equal(path.includes("cookie"), false);
    }
  }
});

test("Starboard repository reads cannot populate the application cache", () => {
  const path = APP_DEFINITIONS.starboard.operations.repository!.path({ id: 123 });
  assert.equal(path, "/api/repos/123?catalogOnly=1");
});

test("read client rejects arbitrary origins and non-HTTPS remote bases", async () => {
  assert.throws(
    () =>
      new ReadClient(
        { unsafe: { path: () => "/ok" } },
        { baseUrl: "http://example.com" },
      ),
    ConnectionError,
  );

  const client = new ReadClient(
    { unsafe: { path: () => "//evil.example/data" } },
    { baseUrl: "https://example.com" },
  );
  await assert.rejects(() => client.call("unsafe", {}), /invalid fixed path/i);
});

test("read client uses GET, applies bounded retry, and never exposes its token", async () => {
  const calls: Array<{ method: string | undefined; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push({
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    if (calls.length === 1) return Response.json({ error: "temporary" }, { status: 503 });
    return Response.json({ items: [{ id: "one", title: "Safe" }] });
  };
  const client = new ReadClient(
    { list: { auth: true, path: () => "/api/items" } },
    {
      baseUrl: "https://example.com",
      token: "rdr_example-token",
      tokenPrefix: "rdr_",
      fetchImpl,
    },
  );

  const payload = await client.call("list", {});
  assert.deepEqual(payload, { items: [{ id: "one", title: "Safe" }] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.equal(calls.every((call) => call.redirect === "manual"), true);
  assert.equal(calls.every((call) => call.authorization === "Bearer rdr_example-token"), true);
  assert.equal(JSON.stringify(payload).includes("rdr_example-token"), false);
});

test("read client stops an unbounded chunked response before buffering it", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(600_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ReadClient(
    { list: { path: () => "/api/items" } },
    {
      baseUrl: "https://example.com",
      fetchImpl: async () => new Response(stream),
    },
  );

  await assert.rejects(() => client.call("list", {}), /exceeded the read bound/i);
  assert.equal(cancelled, true);
});

test("retryable local failures use only an approved static fallback", async () => {
  const urls: string[] = [];
  const client = new ReadClient(
    {
      hot: {
        path: () => "/hot",
        fallback: {
          baseUrl: "https://papers.example",
          path: () => "/data/hot.json",
          mode: "public-static-fallback",
        },
      },
    },
    {
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        return url.startsWith("http://127.0.0.1")
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json([{ id: "fallback-paper" }], {
              headers: { "Last-Modified": "Mon, 10 Aug 2026 12:00:00 GMT" },
            });
      },
    },
  );
  const response = await client.callWithMetadata("hot", {});
  assert.deepEqual(response.payload, [{ id: "fallback-paper" }]);
  assert.equal(response.retrievalMode, "public-static-fallback");
  assert.equal(response.sourceUrl, "https://papers.example/data/hot.json");
  assert.equal(response.freshness, "Mon, 10 Aug 2026 12:00:00 GMT");
  assert.deepEqual(urls, [
    "http://127.0.0.1:8000/hot",
    "http://127.0.0.1:8000/hot",
    "https://papers.example/data/hot.json",
  ]);
});

test("sanitizer removes credential-shaped fields and bounds nested values", () => {
  const result = sanitize({
    title: "Visible",
    authorization: "Bearer secret",
    nested: { apiKey: "secret", note: "safe" },
  });
  assert.deepEqual(result, { title: "Visible", nested: { note: "safe" } });
  assert.equal(sanitizationTruncated({ items: Array.from({ length: 51 }, () => 1) }), true);
  assert.equal(sanitizationTruncated({ title: "Visible", authorization: "removed" }), false);
});

test("normalization returns bounded pages and stable continuation state", () => {
  const app = APP_DEFINITIONS.starboard;
  const tool = app.tools.search_repositories!;
  const result = normalizeToolResult({
    app,
    toolName: "search_repositories",
    tool,
    payload: { repos: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    args: { limit: 2, offset: 0 },
    sourceUrl: "https://starboard.codevetter.com/api/discover?limit=2",
  });
  assert.equal(result.items?.length, 2);
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
});

test("normalization respects app-owned nested pagination without slicing twice", () => {
  const app = APP_DEFINITIONS.setline;
  const tool = app.tools.list_workout_history!;
  const result = normalizeToolResult({
    app,
    toolName: "list_workout_history",
    tool,
    payload: { items: [{ id: "page-two" }], page: { limit: 1, offset: 1, total: 3 } },
    args: { limit: 1, offset: 1 },
    sourceUrl: "https://setline.significanthobbies.com/api/mcp/history?limit=1&offset=1",
  });
  assert.equal(result.items?.[0]?.id, "page-two");
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.truncated, true);
});

test("normalization preserves continuation when an upstream page omits an exact total", () => {
  const app = APP_DEFINITIONS["research-papers"];
  const tool = app.tools.search_research_papers!;
  const result = normalizeToolResult({
    app,
    toolName: "search_research_papers",
    tool,
    payload: {
      results: [{ paper_id: "arxiv:one" }],
      count: 1,
      page: { limit: 1, offset: 2, nextOffset: 3 },
    },
    args: { q: "agent", limit: 1, offset: 2 },
    sourceUrl: "http://127.0.0.1:8000/search?q=agent&limit=1&offset=2",
  });
  assert.equal(result.items?.[0]?.paper_id, "arxiv:one");
  assert.equal(result.total, undefined);
  assert.equal(result.nextOffset, 3);
  assert.equal(result.hasMore, true);
});

test("Research Papers static fallback preserves source filtering and local pagination", () => {
  const app = APP_DEFINITIONS["research-papers"];
  const tool = app.tools.list_hot_papers!;
  const result = normalizeToolResult({
    app,
    toolName: "list_hot_papers",
    tool,
    payload: [
      { paper_id: "arxiv:one", source: "arxiv" },
      { paper_id: "openreview:two", source: "openreview" },
      { paper_id: "arxiv:three", source: "arxiv" },
    ],
    args: { source: "arxiv", limit: 1, offset: 1 },
    sourceUrl: "https://papers.highsignal.app/data/hot.json",
    retrievalMode: "public-static-fallback",
  });
  assert.equal(result.items?.[0]?.paper_id, "arxiv:three");
  assert.equal(result.total, 2);
  assert.equal(result.nextOffset, null);
  assert.equal(result.retrievalMode, "public-static-fallback");
});

test("tool schemas cannot accept arbitrary transport instructions", () => {
  const forbiddenInputs = new Set(["method", "headers", "body", "sql", "path", "origin"]);
  const forbiddenRoutes = /\/(?:rag|admin|ingest|enrich|sync|delete|write|refresh)(?:\/|\?|$)/i;
  for (const app of Object.values(APP_DEFINITIONS)) {
    for (const tool of Object.values(app.tools)) {
      for (const input of Object.keys(tool.inputSchema)) {
        assert.equal(forbiddenInputs.has(input), false, `${app.id}:${tool.operation}:${input}`);
      }
    }
    for (const operation of Object.values(app.operations)) {
      const path = operation.path({ id: "safe", slug: "safe", limit: 10, offset: 0 });
      assert.doesNotMatch(path, forbiddenRoutes, `${app.id}:${path}`);
    }
  }
});

test("detail selection uses an exact configured identifier", () => {
  const app = APP_DEFINITIONS["high-signal"];
  const tool = app.tools.get_signal!;
  const result = normalizeToolResult({
    app,
    toolName: "get_signal",
    tool,
    payload: { signals: [{ slug: "right", title: "Exact" }, { slug: "right-now" }] },
    args: { slug: "right" },
    sourceUrl: "https://highsignal.app/signals.json",
  });
  assert.equal(result.item?.title, "Exact");
  assert.throws(
    () =>
      normalizeToolResult({
        app,
        toolName: "get_signal",
        tool,
        payload: { signals: [{ slug: "right-now" }] },
        args: { slug: "right" },
        sourceUrl: "https://highsignal.app/signals.json",
      }),
    /not found/i,
  );
});

test("public operation routes stay on their verified anonymous surfaces", () => {
  assert.equal(
    APP_DEFINITIONS["high-signal"].operations.track!.path({}),
    "/data/hit-rate.json",
  );
  const readerSearch = APP_DEFINITIONS.reader.operations.search!.path({
    q: "paper",
    projectId: "owner_default",
    limit: 10,
    offset: 0,
  });
  assert.equal(new URL(readerSearch, "https://reader.example").searchParams.get("projectId"), "owner_default");
});

for (const appId of Object.keys(APP_DEFINITIONS) as AppId[]) {
  test(`${appId} advertises explicit read-only tools`, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(appId, async () => Response.json({ items: [] }));
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const catalog = await client.listTools();
      assert.equal(catalog.tools.length, Object.keys(APP_DEFINITIONS[appId].tools).length);
      for (const tool of catalog.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.annotations?.idempotentHint, true);
        assert.ok(tool.inputSchema);
        assert.ok(tool.outputSchema);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
}

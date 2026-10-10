import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppHealthClient,
  AppHealthClientOptions,
  EventInput,
  LogInput,
} from "@saas-maker/app-health";

import {
  appHealthRoute,
  createConnectionsAppHealthClient,
  monitorAppHealthRequest,
} from "../app-health.js";
import type { HostedWorkerEnv } from "../oauth.js";
import worker from "../worker-entry.js";

const baseEnv = {
  AUTH0_ISSUER: "https://fleet-test.us.auth0.com/",
  AUTH0_OWNER_USER_ID: "google-oauth2|owner123456",
} as HostedWorkerEnv;

function clientSpy(options: { rejectFlush?: boolean } = {}) {
  const events: EventInput[] = [];
  const logs: Array<{ event: string; input?: LogInput }> = [];
  let flushes = 0;
  const client: AppHealthClient = {
    record: (event) => events.push(event),
    log: (event, input) => { logs.push({ event, ...(input ? { input } : {}) }); },
    flush: async () => {
      flushes++;
      if (options.rejectFlush) throw new Error("collector unavailable");
    },
    close: async () => {},
    diagnostics: () => ({
      queued: 0,
      sentBatches: 0,
      sentEvents: 0,
      failedBatches: 0,
      retriedBatches: 0,
      droppedInvalid: 0,
      droppedOverflow: 0,
      droppedDelivery: 0,
      lastSendError: null,
    }),
  };
  return { client, events, logs, get flushes() { return flushes; } };
}

test("App Health route identity comes only from fixed gateway routes", () => {
  assert.equal(
    appHealthRoute(new Request("https://reader-mcp.significanthobbies.com/reader/mcp?token=secret")),
    "/reader/mcp",
  );
  assert.equal(
    appHealthRoute(new Request("https://reader-mcp.significanthobbies.com/.well-known/oauth-protected-resource/reader/mcp")),
    "/.well-known/oauth-protected-resource/reader/mcp",
  );
  assert.equal(
    appHealthRoute(new Request("https://reader-mcp.significanthobbies.com/.well-known/openai-apps-challenge")),
    "/.well-known/openai-apps-challenge",
  );
  assert.equal(
    appHealthRoute(new Request("https://reader-mcp.significanthobbies.com/private/user-123?token=secret")),
    undefined,
  );
  assert.equal(
    appHealthRoute(new Request("https://wrong.example/reader/mcp")),
    undefined,
  );
});

test("App Health stays inert without a private ingest key", () => {
  assert.equal(createConnectionsAppHealthClient(baseEnv), null);
  assert.equal(
    createConnectionsAppHealthClient({ ...baseEnv, APP_HEALTH_INGEST_KEY: "  " }),
    null,
  );
});

test("monitor records an allowlisted route without request values", async () => {
  const { client, events, logs } = clientSpy();
  const waits: Promise<unknown>[] = [];
  const request = new Request(
    "https://reader-mcp.significanthobbies.com/reader/mcp?token=secret",
    { method: "POST", headers: { Authorization: "Bearer private" } },
  );

  const response = await monitorAppHealthRequest(
    request,
    { ...baseEnv, APP_HEALTH_STAGE_SAMPLE_RATE: "1" },
    { waitUntil: (promise) => waits.push(promise) },
    async () => Response.json({ ok: true }, { status: 202 }),
    () => client,
  );
  await Promise.all(waits);

  assert.equal(response.status, 202);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "POST");
  assert.equal(events[0]?.route, "/reader/mcp");
  assert.equal(events[0]?.status_code, 202);
  assert.doesNotMatch(JSON.stringify(events), /secret|private/u);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.input?.props?.cold, 1);
});

test("stage log has only bounded schema props and shares the record flush", async () => {
  const spy = clientSpy();
  const waits: Promise<unknown>[] = [];
  const request = new Request("https://mcp.example/reader/mcp?token=secret");
  Object.defineProperty(request, "cf", { value: { colo: "SIN" } });
  const response = await monitorAppHealthRequest(
    request,
    { ...baseEnv, APP_HEALTH_STAGE_SAMPLE_RATE: "1", APP_HEALTH_RELEASE: "test.1" },
    { waitUntil: (promise) => waits.push(promise) },
    async (stages) => {
      stages.auth_ms = 2.4;
      stages.upstream_ms = 7.6;
      return new Response("same body", { status: 202, headers: { "Cache-Control": "no-store" } });
    },
    () => spy.client,
  );
  await Promise.all(waits);
  assert.equal(spy.logs.length, 1);
  const log = spy.logs[0]!;
  assert.equal(log.event, "api.stage_timing");
  assert.equal(log.input?.level, "debug");
  const props = log.input!.props!;
  assert.deepEqual(props, {
    route: "/reader/mcp", status: 202, total_ms: props.total_ms,
    edge_cache: "NONE", inner_cache: "NONE", colo: "SIN", cold: 0,
    release: "test.1", auth_ms: 2, upstream_ms: 8,
  });
  assert.equal(typeof props.total_ms, "number");
  assert.ok(Number(props.total_ms) >= 0 && Number(props.total_ms) <= 600_000);
  assert.equal(response.headers.get("server-timing"), `total;dur=${props.total_ms}, auth;dur=2, upstream;dur=8`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "same body");
  assert.equal(spy.events.length, 1);
  assert.equal(spy.flushes, 1);
  assert.equal(waits.length, 1);
});

test("stage sampling honors 0 and 1 and defaults missing or invalid rates to 0.1", async (t) => {
  let random = 0.05;
  t.mock.method(Math, "random", () => random);
  for (const rate of ["0", "1", undefined, "garbage", "-1", "1.1", "", "Infinity"]) {
    for (const value of [0.05, 0.1]) {
      random = value;
      const spy = clientSpy();
      const request = new Request("https://mcp.example/starboard/mcp");
      Object.defineProperty(request, "cf", { value: { colo: "bad-colo" } });
      const response = await monitorAppHealthRequest(
        request,
        { ...baseEnv, ...(rate !== undefined ? { APP_HEALTH_STAGE_SAMPLE_RATE: rate } : {}), APP_HEALTH_RELEASE: "invalid release" },
        undefined,
        async () => new Response("ok"),
        () => spy.client,
      );
      const expected = rate === "0" ? 0 : rate === "1" || value < 0.1 ? 1 : 0;
      assert.equal(spy.logs.length, expected, `${rate} / ${value}`);
      if (expected) {
        const props = spy.logs[0]!.input!.props!;
        assert.equal(props.colo, "unknown");
        for (const name of ["release", "auth_ms", "upstream_ms"]) assert.equal(name in props, false);
      }
      assert.match(response.headers.get("server-timing")!, /^total;dur=\d+$/);
    }
  }
});

test("stage logging failures preserve the response and still flush records", async () => {
  const spy = clientSpy();
  spy.client.log = () => { throw new Error("log unavailable"); };
  const response = await monitorAppHealthRequest(
    new Request("https://mcp.example/starboard/mcp"),
    { ...baseEnv, APP_HEALTH_STAGE_SAMPLE_RATE: "1" },
    undefined,
    async () => new Response("ok", { status: 201 }),
    () => spy.client,
  );
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "ok");
  assert.equal(spy.events.length, 1);
  assert.equal(spy.flushes, 1);
});

test("worker measures OAuth and upstream only when they run and excludes other routes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([{ paper_id: "one" }]));
  const upstream = await worker.fetch(new Request("https://mcp.example/research-papers/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "list_hot_papers", arguments: { limit: 1, offset: 0 },
    } }),
  }), baseEnv);
  assert.equal(upstream.status, 200);
  assert.match(upstream.headers.get("server-timing")!, /^total;dur=\d+, upstream;dur=\d+$/);
  const auth = await worker.fetch(new Request("https://mcp.example/reader/mcp"), baseEnv);
  assert.match(auth.headers.get("server-timing")!, /^total;dur=\d+, auth;dur=\d+$/);
  for (const path of ["/", "/.well-known/oauth-protected-resource/reader/mcp", "/unknown/mcp"]) {
    const response = await worker.fetch(new Request(`https://mcp.example${path}`), baseEnv);
    assert.equal(response.headers.has("server-timing"), false, path);
  }
});

test("unknown paths emit nothing and collector failure preserves the response", async () => {
  const unknown = clientSpy();
  const unknownResponse = await monitorAppHealthRequest(
    new Request("https://reader-mcp.significanthobbies.com/private/user-123"),
    baseEnv,
    undefined,
    async () => new Response("not found", { status: 404 }),
    () => unknown.client,
  );
  assert.equal(unknownResponse.status, 404);
  assert.equal(unknown.events.length, 0);

  const failed = clientSpy({ rejectFlush: true });
  const waits: Promise<unknown>[] = [];
  const failureResponse = await monitorAppHealthRequest(
    new Request("https://mcp.example/health"),
    baseEnv,
    { waitUntil: (promise) => waits.push(promise) },
    async () => new Response("unavailable", { status: 503 }),
    () => failed.client,
  );
  await Promise.all(waits);
  assert.equal(failureResponse.status, 503);
  assert.equal(await failureResponse.text(), "unavailable");
  assert.equal(failed.events[0]?.route, "/health");
  assert.equal(failed.events[0]?.status_code, 503);
});

test("published client sends one accepted bounded batch", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const collector: NonNullable<AppHealthClientOptions["fetch"]> = async (input, init) => {
    requests.push({ input, ...(init ? { init } : {}) });
    return new Response(null, { status: 202 });
  };
  const env = {
    ...baseEnv,
    APP_HEALTH_INGEST_KEY: "synthetic-test-key",
    APP_HEALTH_ENVIRONMENT: "local",
    APP_HEALTH_RELEASE: "connections-test",
  };
  const client = createConnectionsAppHealthClient(env, collector);
  assert.ok(client);
  client.record({ method: "GET", route: "/health", status_code: 200, duration_ms: 1 });
  await client.flush();

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), "https://ingest.sassmaker.com/v1/ingest");
  const batch = JSON.parse(String(requests[0]?.init?.body)) as {
    environment?: string;
    events: EventInput[];
  };
  assert.equal(batch.environment, "local");
  assert.equal(batch.events[0]?.route, "/health");
  assert.equal(batch.events[0]?.release, "connections-test");
});

import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppHealthClient,
  AppHealthClientOptions,
  EventInput,
} from "@saas-maker/app-health";

import {
  appHealthRoute,
  createConnectionsAppHealthClient,
  monitorAppHealthRequest,
} from "../app-health.js";
import type { HostedWorkerEnv } from "../oauth.js";

const baseEnv = {
  AUTH0_ISSUER: "https://fleet-test.us.auth0.com/",
  AUTH0_OWNER_USER_ID: "google-oauth2|owner123456",
} as HostedWorkerEnv;

function clientSpy(options: { rejectFlush?: boolean } = {}) {
  const events: EventInput[] = [];
  const client: AppHealthClient = {
    record: (event) => events.push(event),
    log: () => {},
    flush: async () => {
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
  return { client, events };
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
  const { client, events } = clientSpy();
  const waits: Promise<unknown>[] = [];
  const request = new Request(
    "https://reader-mcp.significanthobbies.com/reader/mcp?token=secret",
    { method: "POST", headers: { Authorization: "Bearer private" } },
  );

  const response = await monitorAppHealthRequest(
    request,
    baseEnv,
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

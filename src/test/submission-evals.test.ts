import assert from "node:assert/strict";
import test from "node:test";

import { hostedRoute } from "../hosted.js";
import { runPublicSubmissionEvaluations } from "../submission-evals.js";

const knownNegativeTools = new Set([
  "add_to_watchlist",
  "download_pdf",
  "get_admin_queue",
  "get_private_repository",
  "ingest_paper",
  "list_unlisted_timelines",
  "read_private_journal",
  "refresh_providers",
  "save_repository",
  "search_private_corpus",
  "send_starboard_message",
  "update_hobby",
  "train_model",
  "upload_checkpoint",
  "publish_model",
  "update_progress",
  "save_notes",
  "run_interview_code",
  "read_unpublished_research",
  "edit_person_record",
  "download_source_archive",
  "get_private_registry",
  "deploy_product",
  "read_owner_credentials",
  "get_ahrefs_api_key",
  "save_domain_history",
  "query_private_domain",
  "control_playback",
  "edit_station",
  "download_full_catalog",
]);

const evaluationFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const route = hostedRoute(url.pathname, url.hostname);
  assert.ok(route);
  const message = await request.json() as {
    id: number;
    params: { arguments: Record<string, unknown>; name: string };
  };
  const { arguments: argumentsValue, name } = message.params;
  if (knownNegativeTools.has(name)) {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: true, content: [{ type: "text", text: "tool not found" }] },
    });
  }
  assert.equal(route.kind, "adapter");
  assert.ok(route.app.tools[name]);
  if (name === "get_repository") assert.equal(typeof argumentsValue.id, "number");
  if (name === "get_signal" || name === "get_experience") {
    assert.equal(typeof argumentsValue.slug, "string");
  }
  const empty = argumentsValue.q === "zzz-no-review-match-zzz" || argumentsValue.offset === 1_000_000;
  const detail = name.startsWith("get_") || name === "preview_project";
  return Response.json({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      structuredContent: {
        schemaVersion: "1",
        ok: true,
        tool: name,
        ...(detail
          ? { item: { id: 42, slug: "fixture", password: "must-never-enter-receipt" } }
          : { items: empty ? [] : [{ id: 42, slug: "fixture", password: "must-never-enter-receipt" }] }),
      },
    },
  });
};

test("public submission evaluations run all 80 cases and retain only contract evidence", async () => {
  const receipt = await runPublicSubmissionEvaluations({
    fetchImpl: evaluationFetch,
    includePrepared: true,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.scope, "public_protocol");
  assert.deepEqual(receipt.summary, { passed: 80, failed: 0, total: 80 });
  assert.deepEqual(receipt.manualGates, ["private_authenticated_evaluations", "chatgpt_model_behavior"]);
  assert.equal(receipt.checks.filter(({ kind }) => kind === "positive").length, 50);
  assert.equal(receipt.checks.filter(({ kind }) => kind === "negative").length, 30);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("must-never-enter-receipt"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("zzz-no-review-match-zzz"), false);
});

test("public submission evaluations exclude prepared listings until activation", async () => {
  const receipt = await runPublicSubmissionEvaluations({ fetchImpl: evaluationFetch });
  assert.deepEqual(receipt.summary, { passed: 32, failed: 0, total: 32 });
});

test("public submission evaluations retain stable failures without response bodies", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const message = await request.clone().json() as { params: { name: string } };
    if (message.params.name === "get_daily_brief") {
      return new Response("private upstream failure details", { status: 503 });
    }
    return evaluationFetch(request);
  };
  const receipt = await runPublicSubmissionEvaluations({ fetchImpl });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.summary.failed, 1);
  const failure = receipt.checks.find(({ plugin, kind, case: caseNumber }) =>
    plugin === "high-signal" && kind === "positive" && caseNumber === 3
  );
  assert.equal(failure?.errorCode, "tool_call_status_invalid");
  assert.equal(JSON.stringify(receipt).includes("private upstream failure details"), false);
});

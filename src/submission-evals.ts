import { readFile } from "node:fs/promises";

import { HOSTED_ROUTES, hostedRoute } from "./hosted.js";

const PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

type ResultShape = "empty-page" | "item" | "page";

interface Dependency {
  arguments: Record<string, unknown>;
  fields: readonly string[];
  tool: string;
}

interface PositiveEvaluation {
  arguments: Record<string, unknown>;
  dependency?: Dependency;
  shape: ResultShape;
  tool: string;
}

interface PublicEvaluationDefinition {
  negativeTools: readonly [string, string, string];
  positive: readonly [
    PositiveEvaluation,
    PositiveEvaluation,
    PositiveEvaluation,
    PositiveEvaluation,
    PositiveEvaluation,
  ];
}

const PUBLIC_EVALUATIONS: Readonly<Record<string, PublicEvaluationDefinition>> = Object.freeze({
  starboard: {
    positive: [
      { tool: "search_repositories", arguments: { q: "MCP", language: "TypeScript", limit: 1, offset: 0 }, shape: "page" },
      {
        tool: "get_repository",
        arguments: {},
        dependency: {
          tool: "search_repositories",
          arguments: { q: "MCP", limit: 1, offset: 0 },
          fields: ["id"],
        },
        shape: "item",
      },
      {
        tool: "preview_project",
        arguments: { url: "https://github.com/modelcontextprotocol/typescript-sdk" },
        shape: "item",
      },
      { tool: "inspect_tool_adoption", arguments: { q: "React", limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_repositories", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["get_private_repository", "save_repository", "send_starboard_message"],
  },
  "high-signal": {
    positive: [
      { tool: "search_signals", arguments: { q: "AI infrastructure", limit: 1, offset: 0 }, shape: "page" },
      {
        tool: "get_signal",
        arguments: {},
        dependency: {
          tool: "search_signals",
          arguments: { q: "AI", limit: 1, offset: 0 },
          fields: ["slug", "id"],
        },
        shape: "item",
      },
      { tool: "get_daily_brief", arguments: {}, shape: "item" },
      { tool: "get_track_record", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_signals", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["add_to_watchlist", "refresh_providers", "get_admin_queue"],
  },
  "significant-hobbies": {
    positive: [
      { tool: "search_hobbies", arguments: { facet: "makes-something", limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_experiences", arguments: { q: "Northern Lights", limit: 1, offset: 0 }, shape: "page" },
      {
        tool: "get_experience",
        arguments: {},
        dependency: {
          tool: "search_experiences",
          arguments: { q: "Northern Lights", limit: 1, offset: 0 },
          fields: ["slug", "id"],
        },
        shape: "item",
      },
      { tool: "search_public_timelines", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_hobbies", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["read_private_journal", "list_unlisted_timelines", "update_hobby"],
  },
  "research-papers": {
    positive: [
      { tool: "list_hot_papers", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "list_sleepers", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "list_hot_papers", arguments: { source: "arxiv", limit: 1, offset: 0 }, shape: "page" },
      { tool: "get_reading_path", arguments: { slug: "sutskever-carmack-core" }, shape: "item" },
      { tool: "list_hot_papers", arguments: { limit: 1, offset: 1_000_000 }, shape: "empty-page" },
    ],
    negativeTools: ["search_private_corpus", "download_pdf", "ingest_paper"],
  },
  posttrainllm: {
    positive: [
      { tool: "search_published_models", arguments: { q: "TinyStories", limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_published_models", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "get_published_model", arguments: { id: "tinystories" }, shape: "item" },
      { tool: "list_model_benchmarks", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_published_models", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["train_model", "upload_checkpoint", "publish_model"],
  },
  "swe-interview-prep": {
    positive: [
      { tool: "search_curriculum", arguments: { q: "systems", limit: 1, offset: 0 }, shape: "page" },
      { tool: "get_curriculum_item", arguments: { kind: "concept", id: "load-balancing" }, shape: "item" },
      { tool: "list_learning_roadmaps", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_system_design_cases", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_curriculum", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["update_progress", "save_notes", "run_interview_code"],
  },
  "what-it-takes-to-win": {
    positive: [
      { tool: "search_people_and_milestones", arguments: { q: "Microsoft", limit: 1, offset: 0 }, shape: "page" },
      { tool: "get_person_research_record", arguments: { id: "bill-gates" }, shape: "item" },
      { tool: "list_research_categories", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_people_and_milestones", arguments: { category: "Founder/Entrepreneur", limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_people_and_milestones", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["read_unpublished_research", "edit_person_record", "download_source_archive"],
  },
  "saas-maker": {
    positive: [
      { tool: "search_public_products", arguments: { q: "CodeVetter", limit: 1, offset: 0 }, shape: "page" },
      { tool: "get_public_product", arguments: { id: "codevetter" }, shape: "item" },
      { tool: "list_public_surfaces", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "list_public_learnings", arguments: { limit: 1, offset: 0 }, shape: "page" },
      { tool: "search_public_products", arguments: { q: "zzz-no-review-match-zzz", limit: 1, offset: 0 }, shape: "empty-page" },
    ],
    negativeTools: ["get_private_registry", "deploy_product", "read_owner_credentials"],
  },
  drank: {
    positive: [
      { tool: "get_domain_rating", arguments: { domain: "example.com" }, shape: "item" },
      { tool: "get_domain_rating", arguments: { domain: "openai.com" }, shape: "item" },
      { tool: "get_domain_rating", arguments: { domain: "cloudflare.com" }, shape: "item" },
      { tool: "get_domain_rating", arguments: { domain: "github.com" }, shape: "item" },
      { tool: "get_domain_rating", arguments: { domain: "significanthobbies.com" }, shape: "item" },
    ],
    negativeTools: ["get_ahrefs_api_key", "save_domain_history", "query_private_domain"],
  },
  looptv: {
    positive: [
      { tool: "get_catalog_summary", arguments: {}, shape: "item" },
      { tool: "get_catalog_summary", arguments: {}, shape: "item" },
      { tool: "get_catalog_summary", arguments: {}, shape: "item" },
      { tool: "get_catalog_summary", arguments: {}, shape: "item" },
      { tool: "get_catalog_summary", arguments: {}, shape: "item" },
    ],
    negativeTools: ["control_playback", "edit_station", "download_full_catalog"],
  },
});

interface ListingTest {
  expectedTool?: string;
  prompt: string;
}

interface Listing {
  id: string;
  mcpUrl: string;
  tests: { negative: ListingTest[]; positive: ListingTest[] };
}

type EvaluationEvidence = Record<string, boolean | number | string>;

export interface SubmissionEvaluationCheck {
  case: number;
  evidence?: EvaluationEvidence;
  errorCode?: string;
  kind: "negative" | "positive";
  plugin: string;
  status: "failed" | "passed";
}

export interface SubmissionEvaluationReceipt {
  checkedAt: string;
  manualGates: ["private_authenticated_evaluations", "chatgpt_model_behavior"];
  ok: boolean;
  scope: "public_protocol";
  schemaVersion: 1;
  checks: SubmissionEvaluationCheck[];
  summary: { failed: number; passed: number; total: number };
}

export interface SubmissionEvaluationOptions {
  fetchImpl?: typeof fetch;
  includePrepared?: boolean;
  manifest?: { plugins: Listing[] };
  now?: () => Date;
}

class EvaluationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvaluationError";
  }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvaluationError(code);
  return value as Record<string, unknown>;
}

async function boundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new EvaluationError("response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EvaluationError("response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvaluationError("response_encoding_invalid");
  }
}

async function mcpCall(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  id: number,
  tool: string,
  argumentsValue: Record<string, unknown>,
): Promise<{ content: Record<string, unknown>; httpStatus: number; isError: boolean }> {
  let response: Response;
  try {
    response = await fetchImpl(mcpUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Protocol-Version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: argumentsValue },
      }),
    });
  } catch {
    throw new EvaluationError("request_unavailable");
  }
  if (response.status !== 200) throw new EvaluationError("tool_call_status_invalid");
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new EvaluationError("tool_call_content_type_invalid");
  }
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(await boundedText(response)), "tool_call_payload_invalid");
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError("tool_call_json_invalid");
  }
  const result = asRecord(payload.result, "tool_call_result_invalid");
  const content = result.structuredContent === undefined
    ? {}
    : asRecord(result.structuredContent, "tool_call_content_invalid");
  return { content, httpStatus: response.status, isError: result.isError === true };
}

function firstDependencyValue(
  content: Record<string, unknown>,
  fields: readonly string[],
): { field: string; value: number | string } {
  const items = Array.isArray(content.items) ? content.items : [];
  const first = items[0];
  const item = first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : undefined;
  for (const field of fields) {
    const value = item?.[field];
    if ((typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value))) {
      return { field, value };
    }
  }
  throw new EvaluationError("dependency_fixture_missing");
}

function validatePositiveContent(
  content: Record<string, unknown>,
  evaluation: PositiveEvaluation,
): EvaluationEvidence {
  if (content.schemaVersion !== "1" || content.ok !== true || content.tool !== evaluation.tool) {
    throw new EvaluationError("positive_contract_invalid");
  }
  const itemCount = Array.isArray(content.items) ? content.items.length : content.item ? 1 : 0;
  if (evaluation.shape === "item" && itemCount !== 1) throw new EvaluationError("positive_item_missing");
  if (evaluation.shape === "page" && itemCount === 0) throw new EvaluationError("positive_page_empty");
  if (evaluation.shape === "empty-page" && itemCount !== 0) throw new EvaluationError("positive_empty_page_invalid");
  return { httpStatus: 200, itemCount, resultShape: evaluation.shape, tool: evaluation.tool };
}

async function runPositive(
  fetchImpl: typeof fetch,
  listing: Listing,
  evaluation: PositiveEvaluation,
  id: number,
): Promise<EvaluationEvidence> {
  const argumentsValue = { ...evaluation.arguments };
  if (evaluation.dependency) {
    const dependency = await mcpCall(
      fetchImpl,
      listing.mcpUrl,
      id * 100,
      evaluation.dependency.tool,
      evaluation.dependency.arguments,
    );
    if (dependency.isError) throw new EvaluationError("dependency_call_failed");
    const { field, value } = firstDependencyValue(dependency.content, evaluation.dependency.fields);
    argumentsValue[field] = value;
  }
  const result = await mcpCall(fetchImpl, listing.mcpUrl, id, evaluation.tool, argumentsValue);
  if (result.isError) throw new EvaluationError("positive_tool_failed");
  return validatePositiveContent(result.content, evaluation);
}

async function runNegative(
  fetchImpl: typeof fetch,
  listing: Listing,
  tool: string,
  id: number,
): Promise<EvaluationEvidence> {
  const result = await mcpCall(fetchImpl, listing.mcpUrl, id, tool, {});
  if (!result.isError) throw new EvaluationError("negative_tool_accepted");
  return { httpStatus: result.httpStatus, rejected: true };
}

async function execute(
  plugin: string,
  kind: "negative" | "positive",
  index: number,
  operation: () => Promise<EvaluationEvidence>,
): Promise<SubmissionEvaluationCheck> {
  try {
    return { plugin, kind, case: index + 1, status: "passed", evidence: await operation() };
  } catch (error) {
    return {
      plugin,
      kind,
      case: index + 1,
      status: "failed",
      errorCode: error instanceof EvaluationError ? error.code : "unexpected_failure",
    };
  }
}

async function readManifest(): Promise<{ plugins: Listing[] }> {
  const url = new URL("../docs/listings/plugins.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as { plugins: Listing[] };
}

export async function runPublicSubmissionEvaluations(
  options: SubmissionEvaluationOptions = {},
): Promise<SubmissionEvaluationReceipt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifest = options.manifest ?? await readManifest();
  const listings = manifest.plugins.filter(({ id, mcpUrl }) => {
    if (!(id in PUBLIC_EVALUATIONS)) return false;
    const url = new URL(mcpUrl);
    const route = hostedRoute(url.pathname, url.hostname);
    return options.includePrepared || route?.productionStatus !== "prepared";
  });
  const expectedListingCount = options.includePrepared ? 10 : 4;
  if (listings.length !== expectedListingCount) throw new EvaluationError("public_listing_count_invalid");
  const nested = await Promise.all(listings.map(async (listing, pluginIndex) => {
    const definition = PUBLIC_EVALUATIONS[listing.id];
    const url = new URL(listing.mcpUrl);
    const route = hostedRoute(url.pathname, url.hostname);
    if (!definition || !route || route.id !== listing.id || route.audience !== "public") {
      throw new EvaluationError("public_listing_route_invalid");
    }
    if (listing.tests.positive.length !== 5 || listing.tests.negative.length !== 3) {
      throw new EvaluationError("listing_case_count_invalid");
    }
    for (const [index, evaluation] of definition.positive.entries()) {
      if (listing.tests.positive[index]?.expectedTool !== evaluation.tool) {
        throw new EvaluationError("listing_expected_tool_mismatch");
      }
    }
    const positive = definition.positive.map((evaluation, index) =>
      execute(listing.id, "positive", index, () =>
        runPositive(fetchImpl, listing, evaluation, pluginIndex * 100 + index + 1))
    );
    const negative = definition.negativeTools.map((tool, index) =>
      execute(listing.id, "negative", index, () =>
        runNegative(fetchImpl, listing, tool, pluginIndex * 100 + index + 51))
    );
    return Promise.all([...positive, ...negative]);
  }));
  const checks = (await Promise.all(nested)).flat().sort((left, right) =>
    left.plugin.localeCompare(right.plugin) || left.kind.localeCompare(right.kind) || left.case - right.case
  );
  const failed = checks.filter(({ status }) => status === "failed").length;
  return {
    schemaVersion: 1,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    scope: "public_protocol",
    ok: failed === 0,
    checks,
    summary: { passed: checks.length - failed, failed, total: checks.length },
    manualGates: ["private_authenticated_evaluations", "chatgpt_model_behavior"],
  };
}

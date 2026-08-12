import { HOSTED_ROUTES, hostedRoute, oauthResource, type HostedRouteDefinition } from "./hosted.js";

const PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";
const MUTATION_NAME = /(?:^|_)(?:add|create|delete|edit|ingest|log|message|purchase|refresh|remove|save|send|set|sync|update|upload)(?:_|$)/u;

export const PRODUCTION_AUTH0_ISSUER = "https://dev-0suel086hm1blvg7.us.auth0.com/";

interface RepresentativeCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface PaginationCall extends RepresentativeCall {
  limitArgument?: "limit" | "pagesize";
}

const REPRESENTATIVE_CALLS: Readonly<Record<string, RepresentativeCall>> = Object.freeze({
  "starboard": { name: "search_repositories", arguments: { q: "MCP", limit: 1, offset: 0 } },
  "high-signal": { name: "search_signals", arguments: { q: "AI", limit: 1, offset: 0 } },
  "significant-hobbies": { name: "search_hobbies", arguments: { q: "astronomy", limit: 1, offset: 0 } },
  "research-papers": { name: "list_hot_papers", arguments: { limit: 1, offset: 0 } },
  "anime-list-public": { name: "search_anime", arguments: { pagesize: 1, offset: 0 } },
  "swe-interview-prep": { name: "search_curriculum", arguments: { q: "systems", limit: 1, offset: 0 } },
  "saas-maker": { name: "search_public_products", arguments: { q: "CodeVetter", limit: 1, offset: 0 } },
  drank: { name: "get_domain_rating", arguments: { domain: "example.com" } },
});

const PAGINATION_CALLS: Readonly<Record<string, PaginationCall>> = Object.freeze({
  "starboard": { name: "search_repositories", arguments: {} },
  "high-signal": { name: "search_signals", arguments: {} },
  "significant-hobbies": { name: "search_public_timelines", arguments: {} },
  "research-papers": { name: "list_hot_papers", arguments: {} },
  "anime-list-public": { name: "search_anime", arguments: {}, limitArgument: "pagesize" },
  "swe-interview-prep": { name: "search_curriculum", arguments: {} },
  "saas-maker": { name: "search_public_products", arguments: {} },
});

const PERSONAL_PAGINATION_CALLS: Readonly<Record<string, PaginationCall>> = Object.freeze({
  "reader": { name: "list_reader_collections", arguments: {} },
  "calorie": { name: "search_saved_foods", arguments: {} },
  "anime-list": { name: "list_watchlist", arguments: {} },
});

type MonitorEvidence = Record<string, boolean | number | string | string[]>;

export interface ProductionMonitorCheck {
  id: string;
  plugin: string;
  status: "failed" | "passed";
  evidence?: MonitorEvidence;
  errorCode?: string;
}

export interface ProductionMonitorReceipt {
  schemaVersion: 1;
  checkedAt: string;
  ok: boolean;
  checks: ProductionMonitorCheck[];
  summary: { passed: number; failed: number; total: number };
}

export interface ProductionMonitorOptions {
  fetchImpl?: typeof fetch;
  includePrepared?: boolean;
  issuer?: string;
  now?: () => Date;
  personalAuthorizations?: Readonly<Record<string, string>>;
}

class MonitorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MonitorError";
  }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MonitorError(code);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function structuredItemCount(content: Record<string, unknown>): number {
  if (Array.isArray(content.items)) return content.items.length;
  if (content.item && typeof content.item === "object" && !Array.isArray(content.item)) return 1;
  if (Array.isArray(content.data)) return content.data.length;
  if (!content.data || typeof content.data !== "object" || Array.isArray(content.data)) return 0;
  const data = content.data as Record<string, unknown>;
  for (const key of ["items", "filteredList", "results"] as const) {
    if (Array.isArray(data[key])) return data[key].length;
  }
  return 1;
}

interface StructuredPage {
  items: unknown[];
  total: number;
  nextOffset?: number | null;
  hasMore?: boolean;
}

function structuredPage(content: Record<string, unknown>): StructuredPage {
  const data = content.data && typeof content.data === "object" && !Array.isArray(content.data)
    ? content.data as Record<string, unknown>
    : undefined;
  const items = Array.isArray(content.items)
    ? content.items
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.filteredList)
        ? data.filteredList
        : Array.isArray(data?.results)
          ? data.results
          : undefined;
  const totalValue = content.total ?? data?.total ?? data?.totalFiltered;
  if (!items || typeof totalValue !== "number" || !Number.isInteger(totalValue) || totalValue < 0) {
    throw new MonitorError("pagination_contract_invalid");
  }
  const nextValue = content.nextOffset ?? data?.nextOffset;
  const nextOffset = nextValue === null
    ? null
    : typeof nextValue === "number" && Number.isInteger(nextValue) && nextValue >= 0
      ? nextValue
      : undefined;
  const hasMoreValue = content.hasMore ?? data?.hasMore;
  const hasMore = typeof hasMoreValue === "boolean" ? hasMoreValue : undefined;
  return {
    items,
    total: totalValue,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(hasMore === undefined ? {} : { hasMore }),
  };
}

function itemIdentity(item: unknown): string {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    for (const key of ["id", "mal_id", "malId", "slug", "paper_id", "repoId", "full_name"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") return `${key}:${value}`;
    }
  }
  return JSON.stringify(item);
}

function noStore(response: Response): boolean {
  return response.headers.get("cache-control")?.toLowerCase().split(",")
    .some((part) => part.trim() === "no-store") === true;
}

async function boundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new MonitorError("response_too_large");
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
      throw new MonitorError("response_too_large");
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
    throw new MonitorError("response_encoding_invalid");
  }
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new MonitorError("request_unavailable");
  }
}

async function json(response: Response, code: string): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new MonitorError(`${code}_content_type_invalid`);
  }
  try {
    return asRecord(JSON.parse(await boundedText(response)), `${code}_shape_invalid`);
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${code}_json_invalid`);
  }
}

function publishedRoutes(includePrepared = false): Array<{ path: string; route: HostedRouteDefinition; origin: string }> {
  return Object.entries(HOSTED_ROUTES).flatMap(([path, route]) => {
    if (!includePrepared && route.productionStatus === "prepared") return [];
    const host = route.challengeSecret ? route.hosts[0] : undefined;
    return host ? [{ path, route, origin: `https://${host}` }] : [];
  });
}

function mcpBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function mcpHeaders(authorization?: string): HeadersInit {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": PROTOCOL_VERSION,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

async function mcpPost(
  fetchImpl: typeof fetch,
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  authorization?: string,
): Promise<Response> {
  return request(fetchImpl, url, {
    method: "POST",
    headers: mcpHeaders(authorization),
    body: mcpBody(id, method, params),
  });
}

async function executeCheck(
  id: string,
  plugin: string,
  operation: () => Promise<MonitorEvidence>,
): Promise<ProductionMonitorCheck> {
  try {
    return { id, plugin, status: "passed", evidence: await operation() };
  } catch (error) {
    return {
      id,
      plugin,
      status: "failed",
      errorCode: error instanceof MonitorError ? error.code : "unexpected_failure",
    };
  }
}

async function healthCheck(fetchImpl: typeof fetch, origin: string): Promise<MonitorEvidence> {
  const response = await request(fetchImpl, `${origin}/health`, { headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new MonitorError("health_status_invalid");
  const body = await json(response, "health");
  if (body.ok !== true || body.service !== "fleet-chatgpt-connections") {
    throw new MonitorError("health_contract_invalid");
  }
  return { httpStatus: response.status, service: String(body.service) };
}

async function initializeCheck(
  fetchImpl: typeof fetch,
  mcpUrl: string,
): Promise<MonitorEvidence> {
  const response = await mcpPost(fetchImpl, mcpUrl, 1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "fleet-production-monitor", version: "1.0.0" },
  });
  if (response.status !== 200 || !noStore(response)) throw new MonitorError("initialize_status_invalid");
  const payload = await json(response, "initialize");
  const result = asRecord(payload.result, "initialize_result_invalid");
  const serverInfo = asRecord(result.serverInfo, "initialize_server_invalid");
  if (result.protocolVersion !== PROTOCOL_VERSION || typeof serverInfo.name !== "string") {
    throw new MonitorError("initialize_contract_invalid");
  }
  return { httpStatus: response.status, protocolVersion: PROTOCOL_VERSION, serverName: serverInfo.name };
}

async function toolsCheck(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  expectedNames: string[],
): Promise<MonitorEvidence> {
  const response = await mcpPost(fetchImpl, mcpUrl, 2, "tools/list", {});
  if (response.status !== 200) throw new MonitorError("tools_status_invalid");
  const payload = await json(response, "tools");
  const result = asRecord(payload.result, "tools_result_invalid");
  if (!Array.isArray(result.tools) || result.tools.length === 0) throw new MonitorError("tools_empty");
  const names: string[] = [];
  for (const value of result.tools) {
    const tool = asRecord(value, "tool_shape_invalid");
    const annotations = asRecord(tool.annotations, "tool_annotations_invalid");
    if (typeof tool.name !== "string" || annotations.readOnlyHint !== true || annotations.destructiveHint !== false) {
      throw new MonitorError("tool_readonly_contract_invalid");
    }
    if (MUTATION_NAME.test(tool.name)) throw new MonitorError("mutation_tool_advertised");
    const security = Array.isArray(tool.securitySchemes) ? tool.securitySchemes : [];
    if (security.length !== 1 || asRecord(security[0], "tool_security_invalid").type !== "noauth") {
      throw new MonitorError("tool_security_invalid");
    }
    names.push(tool.name);
  }
  names.sort();
  expectedNames.sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new MonitorError("tool_catalog_parity_invalid");
  }
  return { httpStatus: response.status, toolCount: names.length, toolNames: names };
}

async function representativeCallCheck(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  call: RepresentativeCall,
): Promise<MonitorEvidence> {
  const response = await mcpPost(fetchImpl, mcpUrl, 3, "tools/call", {
    name: call.name,
    arguments: call.arguments,
  });
  if (response.status !== 200) throw new MonitorError("tool_call_status_invalid");
  const payload = await json(response, "tool_call");
  const result = asRecord(payload.result, "tool_call_result_invalid");
  if (result.isError === true) throw new MonitorError("tool_call_failed");
  const content = asRecord(result.structuredContent, "tool_call_content_invalid");
  if (content.schemaVersion !== "1" || content.ok !== true || content.tool !== call.name) {
    throw new MonitorError("tool_call_contract_invalid");
  }
  const items = structuredItemCount(content);
  if (items > 1) throw new MonitorError("tool_call_unbounded");
  return {
    httpStatus: response.status,
    schemaVersion: "1",
    toolName: call.name,
    itemCount: items,
    truncated: content.truncated === true,
  };
}

async function paginationCheck(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  call: PaginationCall,
  authorization?: string,
): Promise<MonitorEvidence> {
  const pageSize = 2;
  const limitArgument = call.limitArgument ?? "limit";
  const readPage = async (offset: number, id: number) => {
    const response = await mcpPost(
      fetchImpl,
      mcpUrl,
      id,
      "tools/call",
      {
        name: call.name,
        arguments: { ...call.arguments, [limitArgument]: pageSize, offset },
      },
      authorization,
    );
    if (response.status !== 200) throw new MonitorError("pagination_status_invalid");
    const payload = await json(response, "pagination");
    const result = asRecord(payload.result, "pagination_result_invalid");
    if (result.isError === true) throw new MonitorError("pagination_call_failed");
    return structuredPage(asRecord(result.structuredContent, "pagination_content_invalid"));
  };

  const first = await readPage(0, 7);
  if (first.total < pageSize * 3 || first.items.length !== pageSize) {
    throw new MonitorError("pagination_dataset_too_small");
  }
  const middleOffset = Math.floor((first.total - pageSize) / 2);
  const terminalOffset = first.total - pageSize;
  const [middle, terminal] = await Promise.all([
    readPage(middleOffset, 8),
    readPage(terminalOffset, 9),
  ]);
  if (
    middle.total !== first.total ||
    terminal.total !== first.total ||
    middle.items.length !== pageSize ||
    terminal.items.length !== pageSize
  ) {
    throw new MonitorError("pagination_total_unstable");
  }
  if (
    (first.nextOffset !== undefined && first.nextOffset !== pageSize) ||
    (middle.nextOffset !== undefined && middle.nextOffset !== middleOffset + pageSize) ||
    (terminal.nextOffset !== undefined && terminal.nextOffset !== null) ||
    (first.hasMore !== undefined && !first.hasMore) ||
    (middle.hasMore !== undefined && !middle.hasMore) ||
    (terminal.hasMore !== undefined && terminal.hasMore)
  ) {
    throw new MonitorError("pagination_continuation_invalid");
  }
  const identities = [...first.items, ...middle.items, ...terminal.items].map(itemIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new MonitorError("pagination_overlap_invalid");
  }
  return {
    httpStatus: 200,
    toolName: call.name,
    pageSize,
    total: first.total,
    pagesChecked: 3,
  };
}

async function mutationAbsenceCheck(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  plugin: string,
): Promise<MonitorEvidence> {
  const name = `delete_${plugin.replaceAll("-", "_")}`;
  const response = await mcpPost(fetchImpl, mcpUrl, 4, "tools/call", { name, arguments: {} });
  if (response.status !== 200) throw new MonitorError("mutation_probe_status_invalid");
  const payload = await json(response, "mutation_probe");
  const result = asRecord(payload.result, "mutation_probe_result_invalid");
  if (result.isError !== true) throw new MonitorError("mutation_probe_accepted");
  return { httpStatus: response.status, rejected: true };
}

async function oauthChallengeCheck(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  route: HostedRouteDefinition,
): Promise<MonitorEvidence> {
  const response = await mcpPost(fetchImpl, `${origin}${path}`, 5, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "fleet-production-monitor", version: "1.0.0" },
  });
  const expectedMetadata = `${origin}${PROTECTED_RESOURCE_PREFIX}${path}`;
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (
    response.status !== 401 ||
    !noStore(response) ||
    !challenge.includes(`resource_metadata="${expectedMetadata}"`) ||
    !challenge.includes(`scope="${route.scope}"`)
  ) {
    throw new MonitorError("oauth_challenge_invalid");
  }
  return { httpStatus: response.status, resourceMetadata: expectedMetadata, scope: route.scope ?? "" };
}

async function protectedResourceCheck(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  route: HostedRouteDefinition,
  issuer: string,
): Promise<MonitorEvidence> {
  const url = `${origin}${PROTECTED_RESOURCE_PREFIX}${path}`;
  const response = await request(fetchImpl, url, { headers: { Accept: "application/json" } });
  if (response.status !== 200 || !noStore(response)) throw new MonitorError("resource_status_invalid");
  const metadata = await json(response, "resource");
  const authorizationServers = stringArray(metadata.authorization_servers);
  const scopes = stringArray(metadata.scopes_supported);
  const bearerMethods = stringArray(metadata.bearer_methods_supported);
  const resource = oauthResource(route, `${origin}${path}`);
  if (
    metadata.resource !== resource ||
    authorizationServers?.length !== 1 || authorizationServers[0] !== issuer ||
    scopes?.length !== 1 || scopes[0] !== route.scope ||
    bearerMethods?.includes("header") !== true
  ) {
    throw new MonitorError("resource_contract_invalid");
  }
  return { httpStatus: response.status, resource, scope: route.scope ?? "", issuer };
}

async function authorizationServerCheck(
  fetchImpl: typeof fetch,
  origin: string,
  issuer: string,
): Promise<MonitorEvidence> {
  const response = await request(fetchImpl, `${origin}${AUTHORIZATION_SERVER_PATH}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200 || !noStore(response)) throw new MonitorError("oauth_metadata_status_invalid");
  const metadata = await json(response, "oauth_metadata");
  const methods = stringArray(metadata.code_challenge_methods_supported);
  const grants = stringArray(metadata.grant_types_supported);
  if (
    metadata.issuer !== issuer ||
    metadata.client_id_metadata_document_supported !== true ||
    methods?.includes("S256") !== true ||
    grants?.includes("authorization_code") !== true ||
    grants?.includes("refresh_token") !== true
  ) {
    throw new MonitorError("oauth_metadata_contract_invalid");
  }
  return { httpStatus: response.status, issuer, pkceS256: true, refreshTokens: true };
}

async function isolationCheck(
  fetchImpl: typeof fetch,
  origin: string,
  wrongPath: string,
): Promise<MonitorEvidence> {
  const response = await mcpPost(fetchImpl, `${origin}${wrongPath}`, 6, "initialize", {});
  if (response.status !== 404) throw new MonitorError("host_isolation_invalid");
  return { httpStatus: response.status, rejectedPath: wrongPath };
}

async function monitorRoute(
  fetchImpl: typeof fetch,
  issuer: string,
  entry: { path: string; route: HostedRouteDefinition; origin: string },
  wrongPath: string,
  personalAuthorization?: string,
): Promise<ProductionMonitorCheck[]> {
  const { path, route, origin } = entry;
  const mcpUrl = `${origin}${path}`;
  const checks = [
    executeCheck("health", route.id, () => healthCheck(fetchImpl, origin)),
    executeCheck("host-isolation", route.id, () => isolationCheck(fetchImpl, origin, wrongPath)),
  ];
  if (route.audience === "public") {
    const representative = REPRESENTATIVE_CALLS[route.id];
    if (!representative) throw new MonitorError("representative_call_missing");
    const pagination = PAGINATION_CALLS[route.id];
    checks.push(
      executeCheck("initialize", route.id, () => initializeCheck(fetchImpl, mcpUrl)),
      executeCheck("tools-readonly", route.id, () =>
        toolsCheck(fetchImpl, mcpUrl, route.kind === "adapter" ? Object.keys(route.app.tools) : [...(route.allowedTools ?? [])])),
      executeCheck("representative-read", route.id, () => representativeCallCheck(fetchImpl, mcpUrl, representative)),
      executeCheck("mutation-absence", route.id, () => mutationAbsenceCheck(fetchImpl, mcpUrl, route.id)),
    );
    if (pagination) {
      checks.push(
        executeCheck("pagination", route.id, () => paginationCheck(fetchImpl, mcpUrl, pagination)),
      );
    }
  } else {
    checks.push(
      executeCheck("oauth-challenge", route.id, () => oauthChallengeCheck(fetchImpl, origin, path, route)),
      executeCheck("oauth-resource", route.id, () => protectedResourceCheck(fetchImpl, origin, path, route, issuer)),
      executeCheck("oauth-server", route.id, () => authorizationServerCheck(fetchImpl, origin, issuer)),
    );
    const pagination = PERSONAL_PAGINATION_CALLS[route.id];
    if (personalAuthorization && pagination) {
      checks.push(
        executeCheck("authenticated-pagination", route.id, () =>
          paginationCheck(fetchImpl, mcpUrl, pagination, personalAuthorization)),
      );
    }
  }
  return Promise.all(checks);
}

export async function runProductionMonitor(
  options: ProductionMonitorOptions = {},
): Promise<ProductionMonitorReceipt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issuer = options.issuer ?? PRODUCTION_AUTH0_ISSUER;
  const entries = publishedRoutes(options.includePrepared);
  const expectedRouteCount = options.includePrepared ? 11 : 7;
  if (entries.length !== expectedRouteCount) throw new MonitorError("published_route_count_invalid");
  const nested = await Promise.all(entries.map((entry, index) => {
    const wrongPath = entries[(index + 1) % entries.length]?.path;
    if (!wrongPath || hostedRoute(wrongPath, new URL(entry.origin).hostname)) {
      throw new MonitorError("isolation_probe_invalid");
    }
    return monitorRoute(
      fetchImpl,
      issuer,
      entry,
      wrongPath,
      options.personalAuthorizations?.[entry.route.id],
    );
  }));
  const checks = nested.flat().sort((left, right) =>
    left.plugin.localeCompare(right.plugin) || left.id.localeCompare(right.id)
  );
  const failed = checks.filter((check) => check.status === "failed").length;
  return {
    schemaVersion: 1,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    ok: failed === 0,
    checks,
    summary: { passed: checks.length - failed, failed, total: checks.length },
  };
}

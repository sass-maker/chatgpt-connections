import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  HOSTED_ROUTES,
  hostedRoute,
  oauthResource,
  type HostedRouteDefinition,
} from "./hosted.js";
import type { HostedWorkerEnv, OAuthGrantProps } from "./oauth.js";
import { buildServerForApp, type ToolSecurityScheme } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 256_000;
const MAX_MCP_RESPONSE_BYTES = 1_000_000;
const MAX_PRODUCT_TOKEN_BYTES = 2_048;
const MAX_FEDERATED_TOKEN_BYTES = 20_000;
const NATIVE_TIMEOUT_MS = 10_000;
const ALLOWED_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

class RequestTooLargeError extends Error {}
class ResponseTooLargeError extends Error {}

interface HostedRequestAuthorization {
  grant: OAuthGrantProps;
  upstreamToken: string | undefined;
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );
}

function productUnavailable(): Response {
  return jsonRpcError(
    503,
    -32000,
    "This product connection is temporarily unavailable.",
    { "Retry-After": "300" },
  );
}

function allowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return undefined;
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin) ? origin : undefined;
}

function withProtocolHeaders(
  response: Response,
  request: Request,
  route?: HostedRouteDefinition,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  const origin = allowedOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Mcp-Protocol-Version, Mcp-Session-Id, WWW-Authenticate");
    headers.append("Vary", "Origin");
  }
  if (route?.audience === "personal") {
    headers.set("Pragma", "no-cache");
    headers.set("Vary", [headers.get("Vary"), "Authorization"].filter(Boolean).join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request: Request): Response {
  const origin = allowedOrigin(request);
  if (request.headers.has("origin") && !origin) {
    return jsonRpcError(403, -32000, "Origin is not allowed.");
  }
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Last-Event-ID, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

async function boundedRequest(request: Request): Promise<Request> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MCP_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
  });
}

async function boundedResponse(response: Response): Promise<Response> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
    throw new ResponseTooLargeError();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

function landingResponse(): Response {
  const cards = Object.entries(HOSTED_ROUTES)
    .map(([path, route]) => {
      const name = route.kind === "adapter" ? route.app.name : route.serverName;
      const description =
        route.kind === "adapter"
          ? route.app.instructions.split(/(?<=[.!?])\s/)[0] ?? route.app.instructions
          : `Read-only MCP connection proxied to ${new URL(route.upstreamUrl).hostname}.`;
      const endpoint = `https://${route.hosts[0]}${path}`;
      const access = route.audience === "personal" ? "Owner sign-in" : "Public";
      const status = route.productionStatus === "prepared" ? "prepared" : "live";
      return `      <li class="card">
        <div class="card-head"><h2>${escapeHtml(name)}</h2><span class="badge ${route.audience}">${access}</span></div>
        <p>${escapeHtml(description)}</p>
        <p class="meta"><code>${escapeHtml(endpoint)}</code><span class="status ${status}">${status}</span></p>
      </li>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT Connections — SaaS Maker MCP endpoints</title>
<meta name="description" content="Hosted read-only MCP connections for ChatGPT and other MCP clients: the list of active endpoints, their audiences, and status.">
<style>
:root{--bg:#0c0f0d;--ink:#eef4ef;--muted:#9db3a5;--accent:#6bd29c;--line:rgba(157,179,165,.2);--panel:#11161212}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif;line-height:1.55;font-size:16px}
.shell{width:min(920px,calc(100% - 48px));margin-inline:auto;padding-block:72px}
h1{font-size:clamp(1.9rem,5vw,2.8rem);letter-spacing:-.03em;margin:0 0 12px}
.lede{color:var(--muted);max-width:640px;margin:0 0 40px}
.lede code{color:var(--accent)}
ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:20px 22px;background:var(--panel)}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
h2{font-size:17px;margin:0;font-weight:650}
.card p{margin:8px 0 0;color:var(--muted);font-size:14px}
.meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink)}
.badge,.status{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.badge.public{color:var(--accent);border-color:rgba(107,210,156,.4)}
.badge.personal{color:var(--muted)}
.status.live{color:var(--accent)}
.status.prepared{color:#e0ad4c}
</style>
</head>
<body>
<main class="shell">
  <h1>ChatGPT Connections</h1>
  <p class="lede">Hosted read-only MCP endpoints offered by SaaS Maker. Add a connection in ChatGPT with the endpoint URL. <code>Public</code> endpoints need no account; <code>Owner sign-in</code> endpoints are the owner's personal connectors.</p>
  <ul>
${cards}
  </ul>
</main>
<script src="https://sassmaker.com/project-strip.js" data-project="chatgpt-connections" defer></script>
<script src="https://sassmaker.com/ai-chat-footer.js" data-name="ChatGPT Connections" defer></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src https://sassmaker.com; connect-src https://sassmaker.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function healthResponse(): Response {
  return Response.json(
    {
      ok: true,
      service: "fleet-chatgpt-connections",
      routes: Object.entries(HOSTED_ROUTES).map(([path, route]) => ({
        path,
        auth: route.audience === "personal" ? "oauth2" : "noauth",
      })),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function securitySchemes(route: HostedRouteDefinition): readonly ToolSecurityScheme[] {
  return route.audience === "personal"
    ? [{ type: "oauth2", scopes: [route.scope!] }]
    : [{ type: "noauth" }];
}

async function advertiseSecuritySchemes(
  response: Response,
  route: HostedRouteDefinition,
): Promise<Response> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return response;
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return response;
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return response;
  const schemes = securitySchemes(route);
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const definition = tool as Record<string, unknown>;
    definition.securitySchemes = schemes;
    const meta = definition._meta && typeof definition._meta === "object" && !Array.isArray(definition._meta)
      ? definition._meta as Record<string, unknown>
      : {};
    meta.securitySchemes = schemes;
    definition._meta = meta;
  }
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json(payload, { status: response.status, headers });
}

function exactResource(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

function authorizationMatches(
  request: Request,
  route: HostedRouteDefinition,
  authorization: HostedRequestAuthorization | undefined,
): authorization is HostedRequestAuthorization {
  if (!authorization || route.audience !== "personal" || !route.scope) return false;
  const { grant } = authorization;
  return grant.product === route.id &&
    grant.scope === route.scope &&
    grant.resource === oauthResource(route, exactResource(request)) &&
    typeof grant.subject === "string" && grant.subject.length > 0 && grant.subject.length <= 512;
}

function oauthChallenge(request: Request, route: HostedRouteDefinition): Response {
  const url = new URL(request.url);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${route.scope}", error="invalid_token", error_description="OAuth authorization is required"`;
  return jsonRpcError(401, -32000, "OAuth authorization is required.", {
    "WWW-Authenticate": challenge,
  });
}

function validUpstreamToken(route: HostedRouteDefinition, value: string | undefined): boolean {
  if (!value) return false;
  if (route.authMode === "federated") {
    return value.length <= MAX_FEDERATED_TOKEN_BYTES &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
  }
  if (route.kind !== "adapter") return false;
  if (value.length > MAX_PRODUCT_TOKEN_BYTES) return false;
  return !route.app.tokenPrefix || value.startsWith(route.app.tokenPrefix);
}

async function handleAdapter(
  request: Request,
  route: Extract<HostedRouteDefinition, { kind: "adapter" }>,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<Response> {
  const safeRequest = await boundedRequest(request);
  const server = buildServerForApp(route.app, {
    fetchImpl,
    readProcessEnvironment: false,
    securitySchemes: securitySchemes(route),
    validateTokenPrefix: route.authMode !== "federated",
    ...(token ? { token } : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return advertiseSecuritySchemes(await transport.handleRequest(safeRequest), route);
}

async function handleNative(
  request: Request,
  route: Extract<HostedRouteDefinition, { kind: "native" }>,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<Response> {
  const safeRequest = await boundedRequest(request);
  const body = await safeRequest.arrayBuffer();
  let message: { id?: number | string; method?: string; params?: { name?: string } };
  try {
    message = JSON.parse(new TextDecoder().decode(body)) as typeof message;
  } catch {
    return jsonRpcError(400, -32700, "Invalid JSON-RPC payload.");
  }
  const allowlist = route.allowedTools ? new Set(route.allowedTools) : undefined;
  const allowedPublicNativeMethods = new Set([
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
  ]);
  if (allowlist && !allowedPublicNativeMethods.has(message.method ?? "")) {
    return jsonRpcError(200, -32601, "Method is not available on this connection.");
  }
  if (allowlist && message.method === "tools/call" && !allowlist.has(message.params?.name ?? "")) {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool is not available on this connection." }],
      },
    });
  }
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  for (const name of ["Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"]) {
    const value = request.headers.get(name);
    if (value && value.length <= 256) headers.set(name, value);
  }
  const response = await fetchImpl(route.upstreamUrl, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return jsonRpcError(502, -32603, "Upstream MCP redirects are not allowed.");
  }
  let bounded = await boundedResponse(response);
  const responseIsJson = bounded.headers.get("content-type")?.toLowerCase().includes("application/json") === true;
  if (allowlist && !responseIsJson) {
    await bounded.body?.cancel();
    return jsonRpcError(502, -32603, "Upstream MCP response cannot be safely filtered.");
  }
  if (responseIsJson) {
    const payload = await bounded.clone().json() as Record<string, unknown>;
    const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : undefined;
    if (result && message.method === "initialize") {
      const serverInfo = result.serverInfo && typeof result.serverInfo === "object" && !Array.isArray(result.serverInfo)
        ? result.serverInfo as Record<string, unknown>
        : {};
      serverInfo.name = route.serverName;
      result.serverInfo = serverInfo;
    }
    if (result && allowlist && message.method === "tools/list" && Array.isArray(result.tools)) {
      result.tools = result.tools.filter((tool) =>
        tool && typeof tool === "object" && !Array.isArray(tool) &&
        allowlist.has(String((tool as Record<string, unknown>).name ?? ""))
      );
    }
    const responseHeaders = new Headers(bounded.headers);
    responseHeaders.delete("Content-Length");
    bounded = Response.json(payload, { status: bounded.status, headers: responseHeaders });
  }
  return advertiseSecuritySchemes(bounded, route);
}

export async function handleHostedRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  authorization?: HostedRequestAuthorization,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return healthResponse();
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return landingResponse();
  }

  const route = hostedRoute(url.pathname, url.hostname);
  if (!route) return withProtocolHeaders(jsonRpcError(404, -32001, "Unknown MCP route."), request);
  if (request.headers.has("origin") && !allowedOrigin(request)) {
    return withProtocolHeaders(jsonRpcError(403, -32000, "Origin is not allowed."), request, route);
  }
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") {
    return withProtocolHeaders(
      jsonRpcError(405, -32000, "Only POST and OPTIONS are supported."),
      request,
      route,
    );
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return withProtocolHeaders(
      jsonRpcError(415, -32000, "Content-Type must be application/json."),
      request,
      route,
    );
  }

  if (route.audience === "public") {
    if (request.headers.has("authorization")) {
      return withProtocolHeaders(
        jsonRpcError(401, -32000, "Public MCP routes do not accept credentials."),
        request,
        route,
      );
    }
  } else if (!authorizationMatches(request, route, authorization)) {
    return withProtocolHeaders(oauthChallenge(request, route), request, route);
  } else if (!validUpstreamToken(route, authorization.upstreamToken)) {
    return withProtocolHeaders(productUnavailable(), request, route);
  }

  try {
    const token = route.audience === "personal" ? authorization!.upstreamToken! : undefined;
    const response = route.kind === "native"
      ? await handleNative(request, route, fetchImpl, token)
      : await handleAdapter(request, route, fetchImpl, token);
    return withProtocolHeaders(response, request, route);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return withProtocolHeaders(
        jsonRpcError(413, -32000, "MCP request exceeded the size limit."),
        request,
        route,
      );
    }
    if (error instanceof ResponseTooLargeError) {
      return withProtocolHeaders(
        jsonRpcError(502, -32603, "Upstream MCP response exceeded the size limit."),
        request,
        route,
      );
    }
    console.error(JSON.stringify({
      message: "hosted_mcp_request_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      method: request.method,
      path: url.pathname,
    }));
    return withProtocolHeaders(
      jsonRpcError(500, -32603, "Internal MCP transport error."),
      request,
      route,
    );
  }
}

export function productToken(env: HostedWorkerEnv, route: HostedRouteDefinition): string | undefined {
  switch (route.tokenSecret) {
    case "SETLINE_MCP_TOKEN": return env.SETLINE_MCP_TOKEN;
    default: return "";
  }
}

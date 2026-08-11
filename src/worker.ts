import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  HOSTED_ROUTES,
  hostedRoute,
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
    grant.resource === exactResource(request) &&
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
  token: string,
): Promise<Response> {
  const safeRequest = await boundedRequest(request);
  const body = await safeRequest.arrayBuffer();
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
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
  return advertiseSecuritySchemes(await boundedResponse(response), route);
}

export async function handleHostedRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  authorization?: HostedRequestAuthorization,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return healthResponse();

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
      ? await handleNative(request, route, fetchImpl, token!)
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

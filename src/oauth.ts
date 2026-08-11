import type {
  AuthorizationError,
  AuthRequest,
  ClientInfo,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { hostedRoute, type HostedRouteDefinition } from "./hosted.js";

const FLOW_TTL_SECONDS = 600;
const MAX_FORM_BYTES = 16_384;
const MAX_TOKEN_RESPONSE_BYTES = 32_768;
const MAX_JWKS_BYTES = 65_536;
const CLOCK_SKEW_SECONDS = 60;
const ACCESS_FETCH_TIMEOUT_MS = 5_000;
const CSRF_COOKIE = "__Host-fleet_mcp_csrf";

export interface OAuthGrantProps {
  ownerId: string;
  product: string;
  resource: string;
  scope: string;
}

export interface HostedWorkerEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_ISSUER: string;
  ACCESS_JWKS_URL: string;
  ACCESS_TOKEN_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  OWNER_EMAIL: string;
  READER_MCP_TOKEN: string;
  CALORIE_MCP_TOKEN: string;
  SETLINE_MCP_TOKEN: string;
  ANIME_LIST_MCP_TOKEN: string;
}

interface StoredConsent {
  oauthRequest: AuthRequest;
}

interface StoredAccessState extends StoredConsent {
  codeVerifier: string;
  nonce: string;
}

interface AccessClaims {
  aud: string | string[];
  email: string;
  email_verified?: boolean;
  exp: number;
  iat?: number;
  iss: string;
  nbf?: number;
  nonce: string;
  sub: string;
}

class AuthFlowError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "AuthFlowError";
  }
}

function isAuthorizationError(error: unknown): error is AuthorizationError {
  if (!(error instanceof Error) || error.name !== "AuthorizationError") return false;
  const candidate = error as Error & { code?: unknown; description?: unknown };
  return typeof candidate.code === "string" && typeof candidate.description === "string";
}

function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function oauthError(error: AuthFlowError): Response {
  return Response.json(
    { error: error.code, error_description: "The authorization request could not be completed." },
    { status: error.status, headers: noStoreHeaders() },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

function secureUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthFlowError("server_error", 500);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AuthFlowError("server_error", 500);
  }
  return url;
}

function assertAccessConfig(env: HostedWorkerEnv): void {
  secureUrl(env.ACCESS_AUTHORIZATION_URL);
  secureUrl(env.ACCESS_ISSUER);
  secureUrl(env.ACCESS_JWKS_URL);
  secureUrl(env.ACCESS_TOKEN_URL);
  if (
    !env.ACCESS_CLIENT_ID.trim() || env.ACCESS_CLIENT_ID.length > 512 ||
    env.ACCESS_CLIENT_SECRET.length < 8 || env.ACCESS_CLIENT_SECRET.length > 4_096 ||
    !env.OWNER_EMAIL.trim() || env.OWNER_EMAIL.length > 320 || !env.OWNER_EMAIL.includes("@") ||
    env.COOKIE_ENCRYPTION_KEY.length < 32
  ) {
    throw new AuthFlowError("server_error", 500);
  }
}

function oneResource(oauthRequest: AuthRequest): string {
  const resources = Array.isArray(oauthRequest.resource)
    ? oauthRequest.resource
    : oauthRequest.resource
      ? [oauthRequest.resource]
      : [];
  if (resources.length !== 1) throw new AuthFlowError("invalid_target");
  return resources[0]!;
}

export function privateRouteForAuthorization(
  request: Request,
  oauthRequest: AuthRequest,
): { resource: string; route: HostedRouteDefinition } {
  const resource = oneResource(oauthRequest);
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new AuthFlowError("invalid_target");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.origin !== requestOrigin(request) || parsed.search || parsed.hash) {
    throw new AuthFlowError("invalid_target");
  }
  const route = hostedRoute(parsed.pathname);
  if (!route || route.audience !== "personal" || !route.scope) {
    throw new AuthFlowError("invalid_target");
  }
  if (
    oauthRequest.scope.length !== 1 ||
    oauthRequest.scope[0] !== route.scope
  ) {
    throw new AuthFlowError("invalid_scope");
  }
  return { resource: parsed.href, route };
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function csrfCookie(value: string, maxAge: number): string {
  return `${CSRF_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function randomBase64Url(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmac(value: string, secret: string): Promise<string> {
  if (secret.length < 32) throw new AuthFlowError("server_error", 500);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyHmac(value: string, signature: string, secret: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/iu.test(signature) || secret.length < 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = new Uint8Array(signature.match(/.{2}/gu)!.map((item) => Number.parseInt(item, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(value));
}

async function signedState(secret: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  return { id, token: `${id}.${await hmac(id, secret)}` };
}

async function stateId(token: string, secret: string): Promise<string> {
  const separator = token.lastIndexOf(".");
  if (separator < 1) throw new AuthFlowError("invalid_request");
  const id = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^[a-f0-9-]{36}$/iu.test(id) || !(await verifyHmac(id, signature, secret))) {
    throw new AuthFlowError("invalid_request");
  }
  return id;
}

async function storedJson<T>(kv: KVNamespace, key: string): Promise<T> {
  const value = await kv.get(key, { type: "json" });
  if (!value || typeof value !== "object") throw new AuthFlowError("invalid_request");
  return value as T;
}

function consentPage(
  request: Request,
  client: ClientInfo,
  route: HostedRouteDefinition,
  requestId: string,
  csrf: string,
): Response {
  const name = escapeHtml(client.clientName?.trim() || "ChatGPT");
  const product = escapeHtml(route.id);
  const scope = escapeHtml(route.scope!);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize ${product}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;color:#18181b}
main{border:1px solid #d4d4d8;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.7rem 1rem;border:0;border-radius:8px;background:#18181b;color:white}
code{background:#f4f4f5;padding:.15rem .35rem;border-radius:4px}</style></head><body><main>
<h1>Authorize ${product}</h1><p><strong>${name}</strong> is requesting read-only access to this product.</p>
<p>Permission: <code>${scope}</code>. No product API token will be shared with the client.</p>
<form method="post" action="${escapeHtml(new URL(request.url).pathname)}">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<button type="submit">Continue with Cloudflare Access</button></form></main></body></html>`;
  return new Response(html, {
    headers: noStoreHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Set-Cookie": csrfCookie(csrf, FLOW_TTL_SECONDS),
      "X-Frame-Options": "DENY",
    }),
  });
}

async function beginAuthorization(request: Request, env: HostedWorkerEnv): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;
    if (!error.redirectUri) throw new AuthFlowError(error.code);
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return new Response(null, { status: 302, headers: noStoreHeaders({ Location: redirect.href }) });
  }
  const { route } = privateRouteForAuthorization(request, oauthRequest);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) throw new AuthFlowError("unauthorized_client");
  const requestId = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `fleet:consent:${requestId}`,
    JSON.stringify({ oauthRequest } satisfies StoredConsent),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  const csrf = randomBase64Url();
  return consentPage(request, client, route, requestId, csrf);
}

async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number,
  limit: number,
): Promise<Uint8Array> {
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new AuthFlowError("invalid_request", 413);
  }
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AuthFlowError("invalid_request", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseBoundedForm(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new AuthFlowError("invalid_request", 415);
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  const bytes = await readBodyLimited(request.body, length, MAX_FORM_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthFlowError("invalid_request");
  }
  return new URLSearchParams(text);
}

async function continueToAccess(request: Request, env: HostedWorkerEnv): Promise<Response> {
  assertAccessConfig(env);
  const form = await parseBoundedForm(request);
  const csrf = form.get("csrf_token");
  const requestId = form.get("request_id");
  if (typeof csrf !== "string" || typeof requestId !== "string" ||
      csrf !== cookieValue(request, CSRF_COOKIE) || !/^[a-f0-9-]{36}$/iu.test(requestId)) {
    throw new AuthFlowError("invalid_request");
  }
  const consent = await storedJson<StoredConsent>(env.OAUTH_KV, `fleet:consent:${requestId}`);
  await env.OAUTH_KV.delete(`fleet:consent:${requestId}`);
  privateRouteForAuthorization(request, consent.oauthRequest);

  const codeVerifier = randomBase64Url();
  const nonce = randomBase64Url();
  const state = await signedState(env.COOKIE_ENCRYPTION_KEY);
  await env.OAUTH_KV.put(
    `fleet:access-state:${state.id}`,
    JSON.stringify({ oauthRequest: consent.oauthRequest, codeVerifier, nonce } satisfies StoredAccessState),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  const upstream = secureUrl(env.ACCESS_AUTHORIZATION_URL);
  upstream.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  upstream.searchParams.set("redirect_uri", new URL("/oauth/callback", request.url).href);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("scope", "openid email profile");
  upstream.searchParams.set("state", state.token);
  upstream.searchParams.set("nonce", nonce);
  upstream.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  upstream.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({
      Location: upstream.href,
      "Set-Cookie": csrfCookie("", 0),
    }),
  });
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  let bytes: Uint8Array;
  try {
    bytes = await readBodyLimited(response.body, length, limit);
  } catch {
    throw new AuthFlowError("server_error", 502);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthFlowError("server_error", 502);
  }
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AuthFlowError("access_identity_invalid", 403);
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJwtJson(value: string): Record<string, unknown> {
  const bytes = fromBase64Url(value);
  if (bytes.byteLength > 8_192) throw new AuthFlowError("access_identity_invalid", 403);
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthFlowError("access_identity_invalid", 403);
  }
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

export async function verifyAccessIdToken(
  token: string,
  expectedNonce: string,
  env: Pick<HostedWorkerEnv, "ACCESS_CLIENT_ID" | "ACCESS_ISSUER" | "ACCESS_JWKS_URL" | "OWNER_EMAIL">,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16_384) throw new AuthFlowError("access_identity_invalid", 403);
  const header = parseJwtJson(parts[0]!);
  const claims = parseJwtJson(parts[1]!);
  const kid = header.kid;
  if (
    header.alg !== "RS256" ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    typeof kid !== "string" || kid.length > 256
  ) {
    throw new AuthFlowError("access_identity_invalid", 403);
  }
  const ownerEmail = env.OWNER_EMAIL.trim().toLowerCase();
  const jwksUrl = secureUrl(env.ACCESS_JWKS_URL);
  if (!env.ACCESS_CLIENT_ID.trim() || !ownerEmail || !ownerEmail.includes("@")) {
    throw new AuthFlowError("server_error", 500);
  }
  secureUrl(env.ACCESS_ISSUER);
  const jwksResponse = await fetchImpl(jwksUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(ACCESS_FETCH_TIMEOUT_MS),
  });
  if (!jwksResponse.ok) throw new AuthFlowError("access_identity_unavailable", 502);
  const jwksText = await boundedText(jwksResponse, MAX_JWKS_BYTES);
  let keys: Array<JsonWebKey & { alg?: string; kid?: string }>;
  try {
    const body = JSON.parse(jwksText) as {
      keys?: Array<JsonWebKey & { alg?: string; kid?: string }>;
    };
    keys = Array.isArray(body.keys) ? body.keys : [];
  } catch {
    throw new AuthFlowError("access_identity_unavailable", 502);
  }
  const jwk = keys.find((key) =>
    key.kid === kid &&
    key.kty === "RSA" &&
    (!key.alg || key.alg === "RS256") &&
    (!key.use || key.use === "sig") &&
    (!key.key_ops || key.key_ops.includes("verify")),
  );
  if (!jwk) throw new AuthFlowError("access_identity_invalid", 403);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthFlowError("access_identity_invalid", 403);

  const now = Math.floor(Date.now() / 1000);
  const aud = stringArray(claims.aud);
  if (
    claims.iss !== env.ACCESS_ISSUER ||
    !aud.includes(env.ACCESS_CLIENT_ID) ||
    typeof claims.exp !== "number" || claims.exp <= now - CLOCK_SKEW_SECONDS ||
    (claims.nbf !== undefined && typeof claims.nbf !== "number") ||
    (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) ||
    (claims.iat !== undefined && typeof claims.iat !== "number") ||
    (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) ||
    claims.nonce !== expectedNonce ||
    typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512 ||
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== ownerEmail ||
    (claims.email_verified !== undefined && claims.email_verified !== true)
  ) {
    throw new AuthFlowError("access_identity_invalid", 403);
  }
  return claims as unknown as AccessClaims;
}

async function exchangeAccessCode(
  request: Request,
  env: HostedWorkerEnv,
  state: StoredAccessState,
  fetchImpl: typeof fetch,
): Promise<string> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || code.length > 4_096) throw new AuthFlowError("invalid_request");
  const tokenUrl = secureUrl(env.ACCESS_TOKEN_URL);
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code,
      code_verifier: state.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: new URL("/oauth/callback", request.url).href,
    }),
    signal: AbortSignal.timeout(ACCESS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new AuthFlowError("access_identity_invalid", 403);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await boundedText(response, MAX_TOKEN_RESPONSE_BYTES)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthFlowError) throw error;
    throw new AuthFlowError("access_identity_invalid", 403);
  }
  if (typeof body.id_token !== "string") throw new AuthFlowError("access_identity_invalid", 403);
  return body.id_token;
}

async function finishAuthorization(
  request: Request,
  env: HostedWorkerEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  assertAccessConfig(env);
  const url = new URL(request.url);
  if (url.searchParams.has("error")) throw new AuthFlowError("access_denied", 403);
  const token = url.searchParams.get("state");
  if (!token) throw new AuthFlowError("invalid_request");
  const id = await stateId(token, env.COOKIE_ENCRYPTION_KEY);
  const key = `fleet:access-state:${id}`;
  const state = await storedJson<StoredAccessState>(env.OAUTH_KV, key);
  await env.OAUTH_KV.delete(key);
  const { resource, route } = privateRouteForAuthorization(request, state.oauthRequest);
  const idToken = await exchangeAccessCode(request, env, state, fetchImpl);
  const owner = await verifyAccessIdToken(idToken, state.nonce, env, fetchImpl);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: state.oauthRequest,
    userId: `access-${encodeURIComponent(owner.sub)}`,
    metadata: { product: route.id },
    scope: [route.scope!],
    props: {
      ownerId: owner.sub,
      product: route.id,
      resource,
      scope: route.scope!,
    } satisfies OAuthGrantProps,
  });
  return new Response(null, { status: 302, headers: noStoreHeaders({ Location: redirectTo }) });
}

export async function handleOAuthDefaultRequest(
  request: Request,
  env: HostedWorkerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/oauth/authorize" && request.method === "GET") {
      return await beginAuthorization(request, env);
    }
    if (pathname === "/oauth/authorize" && request.method === "POST") {
      return await continueToAccess(request, env);
    }
    if (pathname === "/oauth/callback" && request.method === "GET") {
      return await finishAuthorization(request, env, fetchImpl);
    }
    if (pathname.startsWith("/oauth/")) throw new AuthFlowError("invalid_request", 404);
    return undefined;
  } catch (error) {
    if (error instanceof AuthFlowError) return oauthError(error);
    console.error(JSON.stringify({
      message: "oauth_flow_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      method: request.method,
      path: pathname,
    }));
    return oauthError(new AuthFlowError("server_error", 500));
  }
}

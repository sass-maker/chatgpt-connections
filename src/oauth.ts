import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import {
  PRIVATE_HOSTED_SCOPES,
  hostedRoute,
  type HostedRouteDefinition,
} from "./hosted.js";

const MAX_AUTHORIZATION_BYTES = 20_000;
const MAX_METADATA_BYTES = 65_536;
const METADATA_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 3_600;
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export interface OAuthGrantProps {
  ownerId: string;
  product: string;
  resource: string;
  scope: string;
}

export type HostedWorkerEnv = Env;

export type WorkosAuthorizationResult =
  | { status: "authorized"; grant: OAuthGrantProps }
  | { status: "missing" | "invalid" }
  | { status: "unavailable" | "misconfigured" };

interface WorkosAccessClaims extends JWTPayload {
  permissions?: unknown;
  scope?: unknown;
  scopes?: unknown;
  sid?: unknown;
}

class WorkosConfigurationError extends Error {
  constructor() {
    super("workos_configuration_invalid");
    this.name = "WorkosConfigurationError";
  }
}

function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

function exactResource(request: Request): string {
  const url = new URL(request.url);
  if ((url.protocol !== "https:" && !isLocalHttp(url)) || url.username || url.password || url.hash) {
    throw new WorkosConfigurationError();
  }
  return `${url.origin}${url.pathname}`;
}

export function workosIssuer(env: Pick<HostedWorkerEnv, "WORKOS_AUTHKIT_DOMAIN">): string {
  let url: URL;
  try {
    url = new URL(env.WORKOS_AUTHKIT_DOMAIN);
  } catch {
    throw new WorkosConfigurationError();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".authkit.app")
  ) {
    throw new WorkosConfigurationError();
  }
  return url.origin;
}

function ownerUserId(env: Pick<HostedWorkerEnv, "WORKOS_OWNER_USER_ID">): string {
  const value = env.WORKOS_OWNER_USER_ID.trim();
  if (!/^user_[A-Za-z0-9]{8,128}$/u.test(value)) throw new WorkosConfigurationError();
  return value;
}

function workosJwksUrl(issuer: string): URL {
  return new URL("/oauth2/jwks", issuer);
}

let cachedIssuer: string | undefined;
let cachedRemoteJwks: JWTVerifyGetKey | undefined;

function remoteJwks(issuer: string): JWTVerifyGetKey {
  if (cachedIssuer !== issuer || !cachedRemoteJwks) {
    cachedIssuer = issuer;
    cachedRemoteJwks = createRemoteJWKSet(workosJwksUrl(issuer), {
      cacheMaxAge: 300_000,
      cooldownDuration: 30_000,
      timeoutDuration: METADATA_FETCH_TIMEOUT_MS,
    });
  }
  return cachedRemoteJwks;
}

function bearerToken(request: Request): string | undefined | null {
  const value = request.headers.get("authorization");
  if (value === null) return undefined;
  if (value.length > MAX_AUTHORIZATION_BYTES) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function stringClaims(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

function grantedPermissions(payload: WorkosAccessClaims): Set<string> {
  return new Set([
    ...stringClaims(payload.scope),
    ...stringClaims(payload.scopes),
    ...stringClaims(payload.permissions),
  ]);
}

function validWorkosClaims(
  payload: WorkosAccessClaims,
  expectedOwnerId: string,
  expectedScope: string,
): payload is WorkosAccessClaims & { exp: number; iat: number; jti: string; sid: string; sub: string } {
  return typeof payload.sub === "string" &&
    payload.sub === expectedOwnerId &&
    typeof payload.exp === "number" &&
    typeof payload.iat === "number" &&
    payload.exp > payload.iat &&
    payload.exp - payload.iat <= MAX_ACCESS_TOKEN_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS &&
    typeof payload.jti === "string" && payload.jti.length > 0 && payload.jti.length <= 256 &&
    typeof payload.sid === "string" && payload.sid.length > 0 && payload.sid.length <= 256 &&
    grantedPermissions(payload).has(expectedScope);
}

export async function verifyWorkosAccessToken(
  token: string,
  request: Request,
  route: HostedRouteDefinition,
  env: Pick<HostedWorkerEnv, "WORKOS_AUTHKIT_DOMAIN" | "WORKOS_OWNER_USER_ID">,
  getKey?: JWTVerifyGetKey,
): Promise<OAuthGrantProps> {
  if (route.audience !== "personal" || !route.scope) throw new WorkosConfigurationError();
  const issuer = workosIssuer(env);
  const resource = exactResource(request);
  const { payload } = await jwtVerify<WorkosAccessClaims>(token, getKey ?? remoteJwks(issuer), {
    algorithms: ["RS256"],
    audience: resource,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    issuer,
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "jti", "sid"],
  });
  const ownerId = ownerUserId(env);
  if (!validWorkosClaims(payload, ownerId, route.scope)) {
    throw new joseErrors.JWTClaimValidationFailed("required WorkOS claims are invalid", payload, "sub");
  }
  return {
    ownerId,
    product: route.id,
    resource,
    scope: route.scope,
  };
}

function isJwksUnavailable(error: unknown): boolean {
  return error instanceof joseErrors.JWKSTimeout ||
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError");
}

export async function authorizeWorkosRequest(
  request: Request,
  route: HostedRouteDefinition,
  env: Pick<HostedWorkerEnv, "WORKOS_AUTHKIT_DOMAIN" | "WORKOS_OWNER_USER_ID">,
  getKey?: JWTVerifyGetKey,
): Promise<WorkosAuthorizationResult> {
  const token = bearerToken(request);
  if (token === undefined) return { status: "missing" };
  if (token === null) return { status: "invalid" };
  try {
    return { status: "authorized", grant: await verifyWorkosAccessToken(token, request, route, env, getKey) };
  } catch (error) {
    if (error instanceof WorkosConfigurationError) {
      console.error(JSON.stringify({ message: "workos_auth_misconfigured", path: new URL(request.url).pathname }));
      return { status: "misconfigured" };
    }
    if (isJwksUnavailable(error)) {
      console.error(JSON.stringify({
        message: "workos_jwks_unavailable",
        errorType: error instanceof Error ? error.name : "UnknownError",
        path: new URL(request.url).pathname,
      }));
      return { status: "unavailable" };
    }
    console.warn(JSON.stringify({
      message: "workos_token_rejected",
      code: error instanceof joseErrors.JOSEError ? error.code : "unknown",
      path: new URL(request.url).pathname,
    }));
    return { status: "invalid" };
  }
}

function protectedMetadataRoute(pathname: string): HostedRouteDefinition | undefined {
  if (!pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`)) return undefined;
  const route = hostedRoute(pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length));
  return route?.audience === "personal" ? route : undefined;
}

function protectedResourceMetadata(
  request: Request,
  route: HostedRouteDefinition,
  issuer: string,
): Response {
  const routePath = protectedMetadataRoute(new URL(request.url).pathname);
  if (routePath !== route || route.audience !== "personal" || !route.scope) {
    return Response.json({ error: "not_found" }, { status: 404, headers: noStoreHeaders() });
  }
  const url = new URL(request.url);
  return Response.json({
    resource: `${url.origin}${url.pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length)}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [route.scope],
    resource_name: `${route.id} read-only MCP`,
  }, { headers: noStoreHeaders() });
}

async function readBodyLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) throw new Error("metadata_too_large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_METADATA_BYTES) {
        await reader.cancel();
        throw new Error("metadata_too_large");
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function sameIssuerEndpoint(value: unknown, issuer: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.origin === issuer &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

function hasStrings(value: unknown, required: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    required.every((item) => value.includes(item));
}

export function validAuthorizationServerMetadata(metadata: Record<string, unknown>, issuer: string): boolean {
  return metadata.issuer === issuer &&
    sameIssuerEndpoint(metadata.authorization_endpoint, issuer) &&
    sameIssuerEndpoint(metadata.token_endpoint, issuer) &&
    sameIssuerEndpoint(metadata.registration_endpoint, issuer) &&
    sameIssuerEndpoint(metadata.introspection_endpoint, issuer) &&
    metadata.client_id_metadata_document_supported === true &&
    hasStrings(metadata.code_challenge_methods_supported, ["S256"]) &&
    hasStrings(metadata.grant_types_supported, ["authorization_code", "refresh_token"]) &&
    hasStrings(metadata.scopes_supported, ["offline_access", ...PRIVATE_HOSTED_SCOPES]);
}

async function proxyAuthorizationServerMetadata(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    const upstream = await fetchImpl(new URL(AUTHORIZATION_SERVER_METADATA_PATH, issuer), {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error("metadata_unavailable");
    const parsed: unknown = JSON.parse(await readBodyLimited(upstream));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata_invalid");
    const metadata = parsed as Record<string, unknown>;
    if (!validAuthorizationServerMetadata(metadata, issuer)) throw new Error("metadata_invalid");
    return Response.json(metadata, { headers: noStoreHeaders() });
  } catch (error) {
    console.error(JSON.stringify({
      message: "workos_metadata_unavailable",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
    return Response.json(
      { error: "authorization_server_unavailable" },
      { status: 503, headers: noStoreHeaders({ "Retry-After": "30" }) },
    );
  }
}

export async function handleWorkosMetadataRequest(
  request: Request,
  env: Pick<HostedWorkerEnv, "WORKOS_AUTHKIT_DOMAIN">,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== AUTHORIZATION_SERVER_METADATA_PATH && !pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`)) {
    return undefined;
  }
  if (request.method !== "GET") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: noStoreHeaders({ Allow: "GET" }) },
    );
  }
  let issuer: string;
  try {
    issuer = workosIssuer(env);
  } catch {
    return Response.json(
      { error: "authorization_server_unavailable" },
      { status: 503, headers: noStoreHeaders({ "Retry-After": "30" }) },
    );
  }
  if (pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
    return proxyAuthorizationServerMetadata(issuer, fetchImpl);
  }
  const route = protectedMetadataRoute(pathname);
  if (!route) return Response.json({ error: "not_found" }, { status: 404, headers: noStoreHeaders() });
  return protectedResourceMetadata(request, route, issuer);
}

import { PRIVATE_HOSTED_PATHS, hostedRoute } from "./hosted.js";
import { validAuthorizationServerMetadata, workosIssuer } from "./oauth.js";

const MAX_METADATA_BYTES = 65_536;
const FETCH_TIMEOUT_MS = 5_000;
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export const MANUAL_ACTIVATION_GATES = Object.freeze([
  "owner_allowlist",
  "registered_resource_indicators",
  "paid_feature_settings",
  "authorization_code_pkce",
  "refresh_rotation",
  "grant_revocation",
] as const);

export interface ActivationVerificationOptions {
  issuer: string;
  gatewayOrigin?: string;
  fetchImpl?: typeof fetch;
}

export interface ActivationVerificationReceipt {
  ok: true;
  checkedAt: string;
  issuer: string;
  gatewayOrigin?: string;
  checks: Array<{ id: string; status: "passed" }>;
  resources: Array<{ id: string; path: string; resource: string; scope: string; status: "passed" }>;
  manualGates: readonly string[];
}

export class ActivationVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ActivationVerificationError";
  }
}

function gatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ActivationVerificationError("gateway_origin_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ActivationVerificationError("gateway_origin_invalid");
  }
  return url.origin;
}

async function responseTextBounded(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) {
    throw new ActivationVerificationError("metadata_too_large");
  }
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
        throw new ActivationVerificationError("metadata_too_large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ActivationVerificationError("metadata_encoding_invalid");
  }
}

async function fetchJson(
  url: URL,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ActivationVerificationError(`${code}_unavailable`);
  }
  if (!response.ok) throw new ActivationVerificationError(`${code}_status_invalid`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ActivationVerificationError(`${code}_content_type_invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await responseTextBounded(response));
  } catch (error) {
    if (error instanceof ActivationVerificationError) throw error;
    throw new ActivationVerificationError(`${code}_json_invalid`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActivationVerificationError(`${code}_json_invalid`);
  }
  return { body: parsed as Record<string, unknown>, headers: response.headers };
}

function validJwks(value: Record<string, unknown>): boolean {
  return Array.isArray(value.keys) && value.keys.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const key = candidate as Record<string, unknown>;
    return key.kty === "RSA" &&
      typeof key.kid === "string" && key.kid.length > 0 && key.kid.length <= 256 &&
      typeof key.n === "string" && key.n.length >= 256 && key.n.length <= 2_048 &&
      /^[A-Za-z0-9_-]+$/u.test(key.n) &&
      typeof key.e === "string" && key.e.length >= 2 && key.e.length <= 16 &&
      /^[A-Za-z0-9_-]+$/u.test(key.e) &&
      (key.alg === undefined || key.alg === "RS256") &&
      (key.use === undefined || key.use === "sig");
  });
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function validProtectedResourceMetadata(
  metadata: Record<string, unknown>,
  resource: string,
  issuer: string,
  scope: string,
): boolean {
  const authorizationServers = strings(metadata.authorization_servers);
  const bearerMethods = strings(metadata.bearer_methods_supported);
  const scopes = strings(metadata.scopes_supported);
  return metadata.resource === resource &&
    authorizationServers?.length === 1 && authorizationServers[0] === issuer &&
    bearerMethods?.includes("header") === true &&
    scopes?.length === 1 && scopes[0] === scope;
}

function noStore(headers: Headers): boolean {
  return headers.get("cache-control")?.toLowerCase().split(",").some((part) => part.trim() === "no-store") === true;
}

export async function verifyActivation(
  options: ActivationVerificationOptions,
): Promise<ActivationVerificationReceipt> {
  let issuer: string;
  try {
    issuer = workosIssuer({ WORKOS_AUTHKIT_DOMAIN: options.issuer });
  } catch {
    throw new ActivationVerificationError("issuer_invalid");
  }
  const origin = options.gatewayOrigin === undefined ? undefined : gatewayOrigin(options.gatewayOrigin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks: Array<{ id: string; status: "passed" }> = [];
  const resources: ActivationVerificationReceipt["resources"] = [];

  const workosMetadata = await fetchJson(
    new URL(AUTHORIZATION_SERVER_METADATA_PATH, issuer),
    "workos_metadata",
    fetchImpl,
  );
  if (!validAuthorizationServerMetadata(workosMetadata.body, issuer)) {
    throw new ActivationVerificationError("workos_metadata_incompatible");
  }
  checks.push({ id: "workos_authorization_server_metadata", status: "passed" });

  const jwks = await fetchJson(new URL("/oauth2/jwks", issuer), "workos_jwks", fetchImpl);
  if (!validJwks(jwks.body)) throw new ActivationVerificationError("workos_jwks_incompatible");
  checks.push({ id: "workos_rs256_jwks", status: "passed" });

  if (origin) {
    const gatewayMetadata = await fetchJson(
      new URL(AUTHORIZATION_SERVER_METADATA_PATH, origin),
      "gateway_metadata",
      fetchImpl,
    );
    if (!validAuthorizationServerMetadata(gatewayMetadata.body, issuer) || !noStore(gatewayMetadata.headers)) {
      throw new ActivationVerificationError("gateway_metadata_incompatible");
    }
    checks.push({ id: "gateway_authorization_server_metadata", status: "passed" });

    for (const path of PRIVATE_HOSTED_PATHS) {
      const route = hostedRoute(path);
      if (!route || route.audience !== "personal" || !route.scope) {
        throw new ActivationVerificationError("private_route_registry_invalid");
      }
      const resource = `${origin}${path}`;
      const metadata = await fetchJson(
        new URL(`${PROTECTED_RESOURCE_METADATA_PREFIX}${path}`, origin),
        `resource_${route.id}`,
        fetchImpl,
      );
      if (!validProtectedResourceMetadata(metadata.body, resource, issuer, route.scope) || !noStore(metadata.headers)) {
        throw new ActivationVerificationError(`resource_${route.id}_metadata_incompatible`);
      }
      resources.push({ id: route.id, path, resource, scope: route.scope, status: "passed" });
    }
    checks.push({ id: "private_resource_metadata", status: "passed" });
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    issuer,
    ...(origin ? { gatewayOrigin: origin } : {}),
    checks,
    resources,
    manualGates: MANUAL_ACTIVATION_GATES,
  };
}

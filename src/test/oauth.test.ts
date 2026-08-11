import assert from "node:assert/strict";
import test from "node:test";

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";

import { PRIVATE_HOSTED_SCOPES, hostedRoute } from "../hosted.js";
import {
  auth0Issuer,
  authorizeOAuthRequest,
  handleOAuthMetadataRequest,
  verifyAuth0AccessToken,
} from "../oauth.js";
import worker from "../worker-entry.js";

const issuer = "https://fleet-test.us.auth0.com/";
const ownerId = "google-oauth2|owner123456";
const resource = "https://mcp.example/reader/mcp";
const scope = "reader.read";
const route = hostedRoute("/reader/mcp")!;
const env = {
  AUTH0_ISSUER: issuer,
  AUTH0_OWNER_USER_ID: ownerId,
};

interface TokenOverrides {
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
  issuer?: string;
  permissions?: string[];
  subject?: string;
}

async function signingFixture(): Promise<{
  getKey: JWTVerifyGetKey;
  token: (overrides?: TokenOverrides) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "auth0-key";
  const getKey = createLocalJWKSet({ keys: [publicJwk] });
  return {
    getKey,
    async token(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const issuedAt = overrides.issuedAt ?? now;
      const payload: Record<string, unknown> = {
        permissions: overrides.permissions ?? [scope],
      };
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "auth0-key", typ: "JWT" })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? resource)
        .setSubject(overrides.subject ?? ownerId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(overrides.expiresAt ?? issuedAt + 300)
        .sign(privateKey);
    },
  };
}

test("Auth0 issuer accepts only the free hosted Auth0 tenant domain", () => {
  assert.equal(auth0Issuer(env), issuer);
  for (const value of [
    "http://fleet-test.us.auth0.com/",
    "https://auth.example.com",
    "https://fleet-test.us.auth0.com/path",
    "https://fleet-test.us.auth0.com:8443/",
  ]) {
    assert.throws(() => auth0Issuer({ AUTH0_ISSUER: value } as Pick<Env, "AUTH0_ISSUER">));
  }
});

test("federated Auth0 verification binds issuer, audience, Google subject, lifetime, and permission", async () => {
  const fixture = await signingFixture();
  const validToken = await fixture.token();
  const request = new Request(resource, { headers: { Authorization: `Bearer ${validToken}` } });
  const grant = await verifyAuth0AccessToken(validToken, request, route, env, fixture.getKey);
  assert.deepEqual(grant, {
    subject: ownerId,
    product: "reader",
    resource,
    scope,
  });

  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { audience: "https://mcp.example/calorie/mcp" },
    { issuer: "https://other.us.auth0.com/" },
    { subject: "auth0|not-google" },
    { permissions: ["calorie.read"] },
    { expiresAt: now - 120 },
    { expiresAt: now + 7_200 },
  ] satisfies TokenOverrides[]) {
    await assert.rejects(
      verifyAuth0AccessToken(await fixture.token(overrides), request, route, env, fixture.getKey),
    );
  }

  const otherGoogle = await verifyAuth0AccessToken(
    await fixture.token({ subject: "google-oauth2|other123456" }),
    request,
    route,
    env,
    fixture.getKey,
  );
  assert.equal(otherGoogle.subject, "google-oauth2|other123456");
});

test("the deferred Setline route remains owner-only", async () => {
  const fixture = await signingFixture();
  const setlineRoute = hostedRoute("/setline/mcp")!;
  const setlineResource = "https://mcp.example/setline/mcp";
  const request = new Request(setlineResource);
  const overrides = { audience: setlineResource, permissions: ["setline.read"] };
  await assert.doesNotReject(
    verifyAuth0AccessToken(await fixture.token(overrides), request, setlineRoute, env, fixture.getKey),
  );
  await assert.rejects(
    verifyAuth0AccessToken(
      await fixture.token({ ...overrides, subject: "google-oauth2|other123456" }),
      request,
      setlineRoute,
      env,
      fixture.getKey,
    ),
  );
});

test("authorization classification never accepts malformed or cross-product bearer tokens", async () => {
  const fixture = await signingFixture();
  const missing = await authorizeOAuthRequest(new Request(resource), route, env, fixture.getKey);
  const malformed = await authorizeOAuthRequest(
    new Request(resource, { headers: { Authorization: "Bearer not-a-jwt" } }),
    route,
    env,
    fixture.getKey,
  );
  const crossProduct = await authorizeOAuthRequest(
    new Request(resource, { headers: { Authorization: `Bearer ${await fixture.token({ permissions: ["calorie.read"] })}` } }),
    route,
    env,
    fixture.getKey,
  );
  const authorizedToken = await fixture.token();
  const authorized = await authorizeOAuthRequest(
    new Request(resource, { headers: { Authorization: `Bearer ${authorizedToken}` } }),
    route,
    env,
    fixture.getKey,
  );
  assert.equal(missing.status, "missing");
  assert.equal(malformed.status, "invalid");
  assert.equal(crossProduct.status, "invalid");
  assert.equal(authorized.status, "authorized");
  if (authorized.status === "authorized") {
    assert.equal(authorized.accessToken, authorizedToken);
    assert.equal(authorized.grant.subject, ownerId);
  }
});

function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}authorize`,
    token_endpoint: `${issuer}oauth/token`,
    registration_endpoint: `${issuer}oidc/register`,
    jwks_uri: `${issuer}.well-known/jwks.json`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["openid", "profile", "email", "offline_access", ...PRIVATE_HOSTED_SCOPES],
  };
}

test("protected resource metadata exposes one exact private route and Auth0 issuer", async () => {
  const response = await handleOAuthMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-protected-resource/reader/mcp"),
    env,
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [scope],
    resource_name: "reader read-only MCP",
  });

  const publicRoute = await handleOAuthMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-protected-resource/starboard/mcp"),
    env,
  );
  assert.ok(publicRoute);
  assert.equal(publicRoute.status, 404);
});

test("authorization-server proxy fails closed unless Auth0 advertises MCP compatibility", async () => {
  let requested = "";
  let requestedRedirect: RequestRedirect | undefined;
  const response = await handleOAuthMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-authorization-server"),
    env,
    async (input, init) => {
      requested = String(input);
      requestedRedirect = init?.redirect;
      return Response.json(authorizationServerMetadata());
    },
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(requested, `${issuer}.well-known/oauth-authorization-server`);
  assert.equal(requestedRedirect, "manual");
  assert.deepEqual(await response.json(), authorizationServerMetadata());

  const invalidMetadata = authorizationServerMetadata();
  delete invalidMetadata.client_id_metadata_document_supported;
  const rejected = await handleOAuthMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-authorization-server"),
    env,
    async () => Response.json(invalidMetadata),
  );
  assert.ok(rejected);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "30");
});

test("Worker entrypoint invokes the runtime fetch with its global receiver", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (function (this: unknown) {
    assert.equal(this, globalThis);
    called = true;
    return Promise.resolve(Response.json(authorizationServerMetadata()));
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      new Request("https://mcp.example/.well-known/oauth-authorization-server"),
      env as Env,
    );
    assert.equal(response.status, 200);
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

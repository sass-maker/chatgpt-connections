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
  authorizeWorkosRequest,
  handleWorkosMetadataRequest,
  verifyWorkosAccessToken,
  workosIssuer,
} from "../oauth.js";

const issuer = "https://fleet-test.authkit.app";
const ownerId = "user_01OWNER123456";
const resource = "https://mcp.example/reader/mcp";
const scope = "reader.read";
const route = hostedRoute("/reader/mcp")!;
const env = {
  WORKOS_AUTHKIT_DOMAIN: issuer,
  WORKOS_OWNER_USER_ID: ownerId,
};

interface TokenOverrides {
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
  issuer?: string;
  permissions?: string[];
  sid?: string | null;
  subject?: string;
}

async function signingFixture(): Promise<{
  getKey: JWTVerifyGetKey;
  token: (overrides?: TokenOverrides) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "workos-key";
  const getKey = createLocalJWKSet({ keys: [publicJwk] });
  return {
    getKey,
    async token(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const issuedAt = overrides.issuedAt ?? now;
      const payload: Record<string, unknown> = {
        jti: "token_01EXAMPLE",
        permissions: overrides.permissions ?? [scope],
      };
      if (overrides.sid !== null) payload.sid = overrides.sid ?? "app_consent_01EXAMPLE";
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "workos-key", typ: "JWT" })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? resource)
        .setSubject(overrides.subject ?? ownerId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(overrides.expiresAt ?? issuedAt + 300)
        .sign(privateKey);
    },
  };
}

test("WorkOS issuer accepts only the free hosted AuthKit domain", () => {
  assert.equal(workosIssuer(env), issuer);
  for (const value of [
    "http://fleet-test.authkit.app",
    "https://auth.example.com",
    "https://fleet-test.authkit.app/path",
    "https://fleet-test.authkit.app:8443",
  ]) {
    assert.throws(() => workosIssuer({ WORKOS_AUTHKIT_DOMAIN: value } as Pick<Env, "WORKOS_AUTHKIT_DOMAIN">));
  }
});

test("WorkOS JWT verification binds issuer, route audience, owner, lifetime, and permission", async () => {
  const fixture = await signingFixture();
  const validToken = await fixture.token();
  const request = new Request(resource, { headers: { Authorization: `Bearer ${validToken}` } });
  const grant = await verifyWorkosAccessToken(validToken, request, route, env, fixture.getKey);
  assert.deepEqual(grant, {
    ownerId,
    product: "reader",
    resource,
    scope,
  });

  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { audience: "https://mcp.example/calorie/mcp" },
    { issuer: "https://other.authkit.app" },
    { subject: "user_01OTHER123456" },
    { permissions: ["calorie.read"] },
    { expiresAt: now - 120 },
    { expiresAt: now + 7_200 },
    { sid: null },
  ] satisfies TokenOverrides[]) {
    await assert.rejects(
      verifyWorkosAccessToken(await fixture.token(overrides), request, route, env, fixture.getKey),
    );
  }
});

test("authorization classification never accepts malformed or cross-product bearer tokens", async () => {
  const fixture = await signingFixture();
  const missing = await authorizeWorkosRequest(new Request(resource), route, env, fixture.getKey);
  const malformed = await authorizeWorkosRequest(
    new Request(resource, { headers: { Authorization: "Bearer not-a-jwt" } }),
    route,
    env,
    fixture.getKey,
  );
  const crossProduct = await authorizeWorkosRequest(
    new Request(resource, { headers: { Authorization: `Bearer ${await fixture.token({ permissions: ["calorie.read"] })}` } }),
    route,
    env,
    fixture.getKey,
  );
  const authorized = await authorizeWorkosRequest(
    new Request(resource, { headers: { Authorization: `Bearer ${await fixture.token()}` } }),
    route,
    env,
    fixture.getKey,
  );
  assert.equal(missing.status, "missing");
  assert.equal(malformed.status, "invalid");
  assert.equal(crossProduct.status, "invalid");
  assert.equal(authorized.status, "authorized");
});

function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    introspection_endpoint: `${issuer}/oauth2/introspection`,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["openid", "profile", "email", "offline_access", ...PRIVATE_HOSTED_SCOPES],
  };
}

test("protected resource metadata exposes one exact private route and WorkOS issuer", async () => {
  const response = await handleWorkosMetadataRequest(
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

  const publicRoute = await handleWorkosMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-protected-resource/starboard/mcp"),
    env,
  );
  assert.ok(publicRoute);
  assert.equal(publicRoute.status, 404);
});

test("authorization-server proxy fails closed unless WorkOS advertises MCP compatibility", async () => {
  let requested = "";
  const response = await handleWorkosMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-authorization-server"),
    env,
    async (input) => {
      requested = String(input);
      return Response.json(authorizationServerMetadata());
    },
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(requested, `${issuer}/.well-known/oauth-authorization-server`);
  assert.deepEqual(await response.json(), authorizationServerMetadata());

  const invalidMetadata = authorizationServerMetadata();
  delete invalidMetadata.client_id_metadata_document_supported;
  const rejected = await handleWorkosMetadataRequest(
    new Request("https://mcp.example/.well-known/oauth-authorization-server"),
    env,
    async () => Response.json(invalidMetadata),
  );
  assert.ok(rejected);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "30");
});

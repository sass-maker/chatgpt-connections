import assert from "node:assert/strict";
import test from "node:test";

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

import { privateRouteForAuthorization, verifyAccessIdToken } from "../oauth.js";

const issuer = "https://fleet.cloudflareaccess.com";
const clientId = "access-client-id";
const ownerEmail = "owner@example.com";

function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "chatgpt-client",
    redirectUri: "https://chatgpt.com/callback",
    scope: ["reader.read"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: "https://mcp.example/reader/mcp",
    ...overrides,
  };
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function signingFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & {
    alg?: string;
    kid?: string;
  };
  publicJwk.alg = "RS256";
  publicJwk.kid = "access-key";
  const fetchImpl: typeof fetch = async () => Response.json({ keys: [publicJwk] });
  return { pair, fetchImpl };
}

async function idToken(
  privateKey: CryptoKey,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", kid: "access-key", typ: "JWT" }));
  const encodedPayload = base64Url(JSON.stringify({
    iss: issuer,
    aud: clientId,
    exp: now + 300,
    iat: now,
    nonce: "expected-nonce",
    sub: "owner-subject",
    email: ownerEmail,
    email_verified: true,
    ...overrides,
  }));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

const verificationEnv = {
  ACCESS_CLIENT_ID: clientId,
  ACCESS_ISSUER: issuer,
  ACCESS_JWKS_URL: `${issuer}/cdn-cgi/access/certs`,
  OWNER_EMAIL: ownerEmail,
};

test("authorization requests bind one private product scope to one exact resource", () => {
  const request = new Request("https://mcp.example/oauth/authorize");
  const result = privateRouteForAuthorization(request, authRequest());
  assert.equal(result.route.id, "reader");
  assert.equal(result.resource, "https://mcp.example/reader/mcp");

  assert.throws(() => privateRouteForAuthorization(request, authRequest({
    resource: "https://evil.example/reader/mcp",
  })));
  assert.throws(() => privateRouteForAuthorization(request, authRequest({
    resource: ["https://mcp.example/reader/mcp", "https://mcp.example/calorie/mcp"],
  })));
  assert.throws(() => privateRouteForAuthorization(request, authRequest({
    scope: ["reader.read", "calorie.read"],
  })));
  assert.throws(() => privateRouteForAuthorization(request, authRequest({
    resource: "https://mcp.example/starboard/mcp",
    scope: ["starboard.read"],
  })));
});

test("Access ID token verification checks signature, issuer, audience, expiry, nonce, and owner", async () => {
  const { pair, fetchImpl } = await signingFixture();
  const valid = await idToken(pair.privateKey);
  const claims = await verifyAccessIdToken(valid, "expected-nonce", verificationEnv, fetchImpl);
  assert.equal(claims.sub, "owner-subject");
  assert.equal(claims.email, ownerEmail);

  for (const overrides of [
    { iss: "https://wrong.example" },
    { aud: "wrong-client" },
    { exp: Math.floor(Date.now() / 1000) - 120 },
    { nonce: "wrong-nonce" },
    { email: "other@example.com" },
    { email_verified: false },
  ]) {
    await assert.rejects(
      verifyAccessIdToken(await idToken(pair.privateKey, overrides), "expected-nonce", verificationEnv, fetchImpl),
    );
  }
});

test("Access ID token verification rejects unknown signing keys and malformed tokens", async () => {
  const { pair } = await signingFixture();
  const valid = await idToken(pair.privateKey);
  await assert.rejects(
    verifyAccessIdToken(valid, "expected-nonce", verificationEnv, async () => Response.json({ keys: [] })),
  );
  await assert.rejects(
    verifyAccessIdToken("not-a-jwt", "expected-nonce", verificationEnv, async () => Response.json({ keys: [] })),
  );
});

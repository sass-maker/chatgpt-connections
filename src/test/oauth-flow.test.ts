import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthRequest,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { handleOAuthDefaultRequest, type HostedWorkerEnv } from "../oauth.js";

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string, options?: { type?: string }): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function authRequest(): AuthRequest {
  return {
    responseType: "code",
    clientId: "chatgpt-client",
    redirectUri: "https://chatgpt.com/aip/callback",
    scope: ["reader.read"],
    state: "chatgpt-state",
    codeChallenge: "chatgpt-challenge",
    codeChallengeMethod: "S256",
    resource: "https://mcp.example/reader/mcp",
    issuer: "https://mcp.example",
  };
}

function formValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`, "u").exec(html);
  assert.ok(match);
  return match[1]!;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function signer() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & {
    alg?: string;
    kid?: string;
  };
  jwk.alg = "RS256";
  jwk.kid = "access-key";
  return { pair, jwk };
}

async function signIdToken(privateKey: CryptoKey, nonce: string, email = "owner@example.com") {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "access-key", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: "https://fleet.cloudflareaccess.com",
    aud: "access-client-id",
    exp: now + 300,
    iat: now,
    nonce,
    sub: "owner-subject",
    email,
    email_verified: true,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function testEnv(
  kv: MemoryKv,
  completed: CompleteAuthorizationOptions[],
): HostedWorkerEnv {
  const helpers = {
    async parseAuthRequest() { return authRequest(); },
    async lookupClient() {
      return {
        clientId: "chatgpt-client",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/aip/callback"],
      };
    },
    async completeAuthorization(options: CompleteAuthorizationOptions) {
      completed.push(options);
      return { redirectTo: "https://chatgpt.com/aip/callback?code=fleet-code" };
    },
  } as unknown as OAuthHelpers;
  return {
    OAUTH_KV: kv as unknown as KVNamespace,
    OAUTH_PROVIDER: helpers,
    ACCESS_AUTHORIZATION_URL: "https://fleet.cloudflareaccess.com/authorize",
    ACCESS_CLIENT_ID: "access-client-id",
    ACCESS_CLIENT_SECRET: "access-client-secret",
    ACCESS_ISSUER: "https://fleet.cloudflareaccess.com",
    ACCESS_JWKS_URL: "https://fleet.cloudflareaccess.com/certs",
    ACCESS_TOKEN_URL: "https://fleet.cloudflareaccess.com/token",
    COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    OWNER_EMAIL: "owner@example.com",
    READER_MCP_TOKEN: "rdr_worker-secret",
    CALORIE_MCP_TOKEN: "calorie_read_worker-secret",
    SETLINE_MCP_TOKEN: "setline_read_worker-secret",
    ANIME_LIST_MCP_TOKEN: "anime_list_worker-secret",
  };
}

async function beginFlow(env: HostedWorkerEnv) {
  const consent = await handleOAuthDefaultRequest(
    new Request("https://mcp.example/oauth/authorize?client_id=chatgpt-client"),
    env,
  );
  assert.ok(consent);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.equal(html.includes("reader.read"), true);
  const requestId = formValue(html, "request_id");
  const csrf = formValue(html, "csrf_token");
  const cookie = consent.headers.get("set-cookie")!.split(";", 1)[0]!;

  const continueResponse = await handleOAuthDefaultRequest(
    new Request("https://mcp.example/oauth/authorize", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, csrf_token: csrf }),
    }),
    env,
  );
  assert.ok(continueResponse);
  assert.equal(continueResponse.status, 302);
  const location = new URL(continueResponse.headers.get("location")!);
  assert.equal(location.origin, "https://fleet.cloudflareaccess.com");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("nonce")?.length, 43);
  return location;
}

test("owner-only Access flow preserves exact product grant and stores no upstream token", async () => {
  const kv = new MemoryKv();
  const completed: CompleteAuthorizationOptions[] = [];
  const env = testEnv(kv, completed);
  const location = await beginFlow(env);
  const state = location.searchParams.get("state")!;
  const stateId = state.slice(0, state.lastIndexOf("."));
  const stored = JSON.parse(kv.values.get(`fleet:access-state:${stateId}`)!) as { nonce: string };
  const { pair, jwk } = await signer();
  const token = await signIdToken(pair.privateKey, stored.nonce);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      return Response.json({ access_token: "must-not-be-stored", id_token: token });
    }
    if (url.endsWith("/certs")) return Response.json({ keys: [jwk] });
    throw new Error("unexpected upstream");
  };
  const callback = await handleOAuthDefaultRequest(
    new Request(`https://mcp.example/oauth/callback?code=access-code&state=${encodeURIComponent(state)}`),
    env,
    fetchImpl,
  );
  assert.ok(callback);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "https://chatgpt.com/aip/callback?code=fleet-code");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0]!.scope, ["reader.read"]);
  assert.equal(completed[0]!.userId, "access-owner-subject");
  assert.deepEqual(completed[0]!.props, {
    ownerId: "owner-subject",
    product: "reader",
    resource: "https://mcp.example/reader/mcp",
    scope: "reader.read",
  });
  assert.equal(JSON.stringify(completed[0]).includes("must-not-be-stored"), false);
  assert.equal(kv.values.has(`fleet:access-state:${stateId}`), false);
});

test("Access flow denies a non-owner before creating an MCP grant", async () => {
  const kv = new MemoryKv();
  const completed: CompleteAuthorizationOptions[] = [];
  const env = testEnv(kv, completed);
  const location = await beginFlow(env);
  const state = location.searchParams.get("state")!;
  const stateId = state.slice(0, state.lastIndexOf("."));
  const stored = JSON.parse(kv.values.get(`fleet:access-state:${stateId}`)!) as { nonce: string };
  const { pair, jwk } = await signer();
  const token = await signIdToken(pair.privateKey, stored.nonce, "other@example.com");
  const response = await handleOAuthDefaultRequest(
    new Request(`https://mcp.example/oauth/callback?code=access-code&state=${encodeURIComponent(state)}`),
    env,
    async (input) => String(input).endsWith("/token")
      ? Response.json({ id_token: token })
      : Response.json({ keys: [jwk] }),
  );
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(completed.length, 0);
});

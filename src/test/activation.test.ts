import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ActivationVerificationError,
  MANUAL_ACTIVATION_GATES,
  verifyActivation,
} from "../activation.js";
import { PRIVATE_HOSTED_PATHS, PRIVATE_HOSTED_SCOPES, hostedRoute, oauthResource } from "../hosted.js";

const issuer = "https://fleet-test.us.auth0.com/";
const gateway = "https://mcp.example.com";

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
    scopes_supported: ["openid", "offline_access", ...PRIVATE_HOSTED_SCOPES],
  };
}

function json(value: unknown, noStore = false): Response {
  return Response.json(value, { headers: noStore ? { "Cache-Control": "no-store" } : {} });
}

function successfulFetch(seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    seen.push(url.href);
    if (url.origin === new URL(issuer).origin && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(authorizationServerMetadata());
    }
    if (url.origin === new URL(issuer).origin && url.pathname === "/.well-known/jwks.json") {
      return json({ keys: [{ kty: "RSA", kid: "auth0-key", alg: "RS256", use: "sig", n: "A".repeat(342), e: "AQAB" }] });
    }
    if (url.origin === gateway && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(authorizationServerMetadata(), true);
    }
    const prefix = "/.well-known/oauth-protected-resource";
    if (url.origin === gateway && url.pathname.startsWith(`${prefix}/`)) {
      const path = url.pathname.slice(prefix.length);
      const route = hostedRoute(path);
      if (!route || route.audience !== "personal" || !route.scope) return json({ error: "not_found" });
      return json({
        resource: oauthResource(route, `${gateway}${path}`),
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [route.scope],
      }, true);
    }
    return json({ error: "not_found" }, true);
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ActivationVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("activation verifier proves Auth0 metadata, JWKS, and every exact private resource", async () => {
  const seen: string[] = [];
  const receipt = await verifyActivation({ issuer, gatewayOrigin: gateway, fetchImpl: successfulFetch(seen) });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.issuer, issuer);
  assert.equal(receipt.gatewayOrigin, gateway);
  assert.match(receipt.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(receipt.checks, [
    { id: "auth0_authorization_server_metadata", status: "passed" },
    { id: "auth0_rs256_jwks", status: "passed" },
    { id: "gateway_authorization_server_metadata", status: "passed" },
    { id: "private_resource_metadata", status: "passed" },
  ]);
  assert.deepEqual(receipt.resources.map(({ id, path, scope }) => ({ id, path, scope })), [
    { id: "reader", path: "/reader/mcp", scope: "reader.read" },
    { id: "calorie", path: "/calorie/mcp", scope: "calorie.read" },
    { id: "setline", path: "/setline/mcp", scope: "setline.read" },
    { id: "anime-list", path: "/anime-list/mcp", scope: "anime-list.read" },
  ]);
  assert.deepEqual(receipt.manualGates, MANUAL_ACTIVATION_GATES);
  assert.equal(seen.length, PRIVATE_HOSTED_PATHS.length + 3);
});

test("activation verifier can check Auth0 before the gateway exists", async () => {
  const seen: string[] = [];
  const receipt = await verifyActivation({ issuer, fetchImpl: successfulFetch(seen) });
  assert.equal(receipt.gatewayOrigin, undefined);
  assert.deepEqual(receipt.resources, []);
  assert.deepEqual(receipt.checks.map((check) => check.id), [
    "auth0_authorization_server_metadata",
    "auth0_rs256_jwks",
  ]);
  assert.equal(seen.length, 2);
});

test("activation verifier rejects non-Auth0 domains and malformed gateway origins before fetching", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return json({});
  };
  await rejectsWithCode(
    verifyActivation({ issuer: "https://auth.example.com", fetchImpl }),
    "issuer_invalid",
  );
  await rejectsWithCode(
    verifyActivation({ issuer, gatewayOrigin: "https://mcp.example.com/path", fetchImpl }),
    "gateway_origin_invalid",
  );
  assert.equal(calls, 0);
});

test("activation verifier fails closed on incompatible Auth0 or gateway metadata", async () => {
  const missingOffline = authorizationServerMetadata();
  missingOffline.scopes_supported = PRIVATE_HOSTED_SCOPES;
  await rejectsWithCode(
    verifyActivation({
      issuer,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        return url.pathname === "/.well-known/jwks.json"
          ? json({ keys: [{ kty: "RSA", kid: "key", n: "A".repeat(342), e: "AQAB" }] })
          : json(missingOffline);
      },
    }),
    "auth0_metadata_incompatible",
  );

  const fetchImpl = successfulFetch();
  await rejectsWithCode(
    verifyActivation({
      issuer,
      gatewayOrigin: gateway,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === gateway && url.pathname === "/.well-known/oauth-authorization-server") {
          return json(authorizationServerMetadata());
        }
        return fetchImpl(input, init);
      },
    }),
    "gateway_metadata_incompatible",
  );
});

test("activation verifier rejects a cross-product resource and oversized metadata", async () => {
  const fetchImpl = successfulFetch();
  await rejectsWithCode(
    verifyActivation({
      issuer,
      gatewayOrigin: gateway,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/reader/mcp")) {
          return json({
            resource: `${gateway}/calorie/mcp`,
            authorization_servers: [issuer],
            bearer_methods_supported: ["header"],
            scopes_supported: ["reader.read"],
          }, true);
        }
        return fetchImpl(input, init);
      },
    }),
    "resource_reader_metadata_incompatible",
  );

  await rejectsWithCode(
    verifyActivation({
      issuer,
      fetchImpl: async () => new Response("{}", {
        headers: { "Content-Length": "70000", "Content-Type": "application/json" },
      }),
    }),
    "metadata_too_large",
  );
});

test("activation CLI accepts pnpm's conventional argument separator", () => {
  const script = fileURLToPath(new URL("../verify-activation.js", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: verify-activation/u);

  const invalidIssuer = spawnSync(
    process.execPath,
    [script, "--", "--issuer", "https://auth.example.com"],
    { encoding: "utf8" },
  );
  assert.equal(invalidIssuer.status, 1);
  assert.match(invalidIssuer.stderr, /"code":"issuer_invalid"/u);
  assert.doesNotMatch(invalidIssuer.stderr, /arguments_invalid/u);
});

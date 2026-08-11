# Hosted runtime compatibility

Checked on 2026-08-11 before the hosted transport was added.

## Dependency gate

- Fleet `code-cleanup` receipt: `run_934938eddf4e27f0000e80a10ba6b271`.
- The existing `@modelcontextprotocol/sdk` 1.29.0 package includes
  `WebStandardStreamableHTTPServerTransport`, documented by the package for
  Cloudflare Workers and other Web Standards runtimes.
- The initial anonymous hosted transport required no new production runtime
  dependency. The MCP SDK remains pinned at 1.29.0 pending separate approval
  for a production dependency upgrade.
- The original hosted-personal revision used
  `@cloudflare/workers-oauth-provider` 0.10.3 and a custom Cloudflare Access
  bridge. The WorkOS revision supersedes both: AuthKit and Connect own CIMD,
  DCR compatibility, PKCE, consent, access/refresh tokens, rotation, and
  revocation outside the Worker.
- The 2026-08-11 WorkOS cleanup gate replaced that provider with direct
  `jose` 6.2.8. `jose` is the verifier in WorkOS's MCP documentation, is
  MIT-licensed, uses Web Crypto in Workers, and was already present through the
  pinned MCP SDK. Making it direct avoids depending on a transitive import and
  removes the Worker-owned OAuth/KV implementation.
- Wrangler 4.120.1 is pinned as development-only build, type-generation,
  local-smoke, and deployment tooling.
- The audit's moderate `@hono/node-server` advisory remains visible. This
  helper does not import the Node/Hono static-file server path implicated by
  that Windows-only advisory. The WorkOS dependency swap introduced no new
  audit finding. Updating the MCP SDK remains a separate
  production-dependency decision.

## Cloudflare architecture gate

- Reviewed the current Cloudflare Workers best-practices page, Wrangler
  4.120.1 configuration schema, and `@cloudflare/workers-types`
  5.20260811.1 before implementation.
- The Worker will use a current `compatibility_date`, `nodejs_compat`, generated
  binding types, structured secret-free error logs, and enabled observability.
- MCP servers and transports will be constructed per request. No bearer,
  session, request body, tool result, or mutable request state may enter module
  scope, a binding, a cache, or a log.
- The Worker has no OAuth KV, authorization endpoint, token endpoint, callback,
  client database, cookie encryption key, WorkOS API key, or WorkOS client
  secret. WorkOS retains the OAuth protocol state; application data remains in
  each product.
- Private product tokens and the WorkOS hosted issuer/owner ID are separate
  required Worker bindings. ChatGPT's WorkOS bearer token is validated and
  never forwarded. A fixed product token is selected only after the product,
  permission, owner `sub`, and exact route audience match.
- WorkOS access-token validation checks an RS256 signature through the hosted
  JWKS, exact `*.authkit.app` issuer, exact route URL audience, expiry and
  issued-at bounds, maximum one-hour lifetime, token/consent identifiers,
  allowlisted owner user ID, and exact product read permission. Invalid tokens
  fail with an OAuth challenge; JWKS/config failures return a bounded 503 and
  never invoke an upstream product.
- Protected-resource metadata is route-specific. The compatibility discovery
  proxy fails closed unless WorkOS advertises CIMD, DCR, PKCE S256,
  authorization-code and refresh-token grants, `offline_access`, and every
  private product scope.
- The dependency-free activation verifier applies the same compatibility
  contract to WorkOS's public metadata and JWKS before deployment, then to the
  gateway discovery proxy and four exact private resource documents after
  deployment. Its receipt names dashboard/live-grant gates that public metadata
  cannot prove instead of treating them as passed.
- The WorkOS cost boundary is also fail-closed at activation: hosted AuthKit
  domain only, below one million MAU, and no custom domain, enterprise SSO,
  Directory Sync, Cross App Access, or other paid feature.
- Only fixed product routes and allowlisted upstream GET operations are
  addressable. Anime List is a fixed POST-only native MCP proxy. Protocol
  request bodies and upstream responses remain bounded.
- MCP protocol responses use `no-store`, including anonymous routes; upstream
  products may retain their own conservative public caching behavior.

References:

- <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- <https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/>
- <https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/>
- <https://workos.com/docs/authkit/mcp>
- <https://developers.openai.com/plugins/build/auth>
- <https://github.com/modelcontextprotocol/typescript-sdk>

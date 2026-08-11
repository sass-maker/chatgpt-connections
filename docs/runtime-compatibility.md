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
- The approved hosted-personal revision requires OAuth 2.1. Fleet
  `code-cleanup` receipt `run_2847f0f4c5774bd81c7d9442ccd26764`
  covers the exact addition of `@cloudflare/workers-oauth-provider` 0.10.3.
  It is Cloudflare-maintained, MIT-licensed, has no production dependencies of
  its own, and was the current release at the gate. It replaces a custom OAuth
  implementation for CIMD, PKCE, hashed access and refresh
  tokens, encrypted grant props, resource audiences, rotation, and revocation.
- Wrangler 4.120.1 is pinned as development-only build, type-generation,
  local-smoke, and deployment tooling.
- The audit's moderate `@hono/node-server` advisory remains visible. This
  helper does not import the Node/Hono static-file server path implicated by
  that Windows-only advisory. The OAuth dependency introduced no additional
  audit finding. Updating the MCP SDK remains a separate production-dependency
  decision.

## Cloudflare architecture gate

- Reviewed the current Cloudflare Workers best-practices page, Wrangler
  4.120.1 configuration schema, and `@cloudflare/workers-types`
  5.20260811.1 before implementation.
- The Worker will use a current `compatibility_date`, `nodejs_compat`, generated
  binding types, structured secret-free error logs, and enabled observability.
- MCP servers and transports will be constructed per request. No bearer,
  session, request body, tool result, or mutable request state may enter module
  scope, a binding, a cache, or a log.
- The Worker has one dedicated `OAUTH_KV` namespace. It may contain only OAuth
  client metadata, grants, hashed token material, encrypted grant props, and
  short-lived consent/Access state. It is not an application or account store.
- Private product tokens and Cloudflare Access OIDC configuration are separate
  required Worker secrets. ChatGPT's bearer token is validated by the OAuth
  provider and never forwarded. A fixed product token is selected only after
  the decrypted product, scope, owner, and exact resource match the route.
- Access identity validation checks the ID-token signature, exact issuer,
  Access client audience, expiry/not-before/issued-at bounds, nonce, subject,
  verified-status when present, and the exact owner email allowlist before a
  grant is created. The upstream Access token is neither retained nor placed in
  the MCP grant.
- Only fixed product routes and allowlisted upstream GET operations are
  addressable. Anime List is a fixed POST-only native MCP proxy. Protocol
  request bodies and upstream responses remain bounded.
- MCP protocol responses use `no-store`, including anonymous routes; upstream
  products may retain their own conservative public caching behavior.

References:

- <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- <https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/>
- <https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/>
- <https://developers.openai.com/plugins/build/auth>
- <https://github.com/modelcontextprotocol/typescript-sdk>

# ChatGPT Connections

## Why / What

ChatGPT Connections is Fleet's shared read-only MCP gateway for existing
cloud-backed product data. Public product routes remain anonymous; Reader,
Calorie, and Anime List use user-scoped federated OAuth that is verified by
both the gateway and the owning product. CodeVetter and other device-local
sources remain outside this gateway.

Multi-user account linking, mutations, device-only data upload, private
Significant Hobbies records, and the full local Research Papers corpus are out
of scope.

## Dependencies

- Cloudflare Workers for the Streamable HTTP OAuth resource server.
- Auth0 free plan for owner identity, consent, CIMD client
  registration, access/refresh tokens, and revocation.
- `jose` for audience-bound Auth0 JWT and JWKS verification.
- Existing read-only product APIs and public exports for upstream data.
- ChatGPT web developer mode for hosted MCP registration.

## Timeline

- 2026-08-11 — Added the fixed-route Worker implementation, OAuth isolation,
  public/private security schemes, tests, path-scoped CI, and guarded manual
  deployment path.
- 2026-08-11 — Replaced the custom Cloudflare Access OAuth bridge and KV token
  state with an Auth0 resource-server boundary, CIMD, and no-card cost guard.
- 2026-08-11 — Configured the free Auth0 tenant, verified the Google owner,
  enabled CIMD/resource compatibility, and created four exact one-hour API
  audiences with default third-party user grants.
- 2026-08-11 — Released the SHA-tagged gateway, verified all OAuth/resource
  metadata, initialized all eight routes, and completed representative public
  tool calls without retaining record bodies.
- 2026-08-11 — Released Reader, Calorie, and Anime List federated verifiers;
  attached seven independent branded custom domains; published seven complete
  OpenAI listing packages; and passed branded OAuth plus live read-only,
  host-isolation, and mutation-absence checks.

## Products

- `fleet-chatgpt-connections` — Live SHA-tagged Cloudflare Worker at the
  compatibility `workers.dev` origin and seven independent branded domains.
- Seven public plugin endpoints: Reader, Calorie, Anime List, Starboard, High
  Signal, Significant Hobbies, and Research Papers.
- Setline remains a fail-closed compatibility route and is not published.

## Features (shipped)

- Fixed per-product Streamable HTTP MCP routes with explicit read-only tools.
- Anonymous public routes that reject credentials.
- Auth0 subject, exact route audience, lifetime, and product-read permission
  checks for federated personal routes, repeated by the owning product API.
- Bounded requests, responses, upstream timeouts, safe CORS, no-store private
  responses, and secret-safe logging.
- Exact per-tool OAuth or no-auth security declarations.
- Path-scoped CI and a clean-main, green-CI, SHA-tagged manual deploy gate.
- Free Auth0 tenant activation with CIMD, PKCE/refresh metadata, exact
  resource audiences, one-hour RS256 tokens, owner allowlisting, and
  third-party user grants; DCR, custom domains, and paid features stay off.
- Production metadata/JWKS verification and status-only public/private smoke
  receipts. Setline remains fail-closed until its first owner token exists.
- Seven unique branded hosts with isolated OpenAI plaintext-challenge bindings;
  absent challenge secrets fail closed until the portal creates each draft.
- Seven portal-ready listing packages with branded icons, legal/support links,
  starter prompts, release notes, and positive/negative review tests.

## Work queue

[Fleet Workspace GitHub Issues](https://github.com/sass-maker/fleet-workspace/issues)

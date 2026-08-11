# ChatGPT Connections

## Why / What

ChatGPT Connections is Fleet's shared read-only MCP gateway for existing
cloud-backed product data. Public product routes remain anonymous; personal
product routes use owner-only OAuth and keep product credentials inside the
Worker. CodeVetter and other device-local sources remain outside this gateway.

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

## Products

- `fleet-chatgpt-connections` — Cloudflare Worker source; production deployment
  is pending Worker secrets and the guarded release path.
- Eight independent MCP route definitions: Reader, Calorie, Setline, Anime
  List, Starboard, High Signal, Significant Hobbies, and Research Papers.

## Features (shipped)

- Fixed per-product Streamable HTTP MCP routes with explicit read-only tools.
- Anonymous public routes that reject credentials.
- Auth0 owner, route audience, lifetime, and product-read permission checks for
  personal routes; upstream product tokens stay in matching Worker secrets.
- Bounded requests, responses, upstream timeouts, safe CORS, no-store private
  responses, and secret-safe logging.
- Exact per-tool OAuth or no-auth security declarations.
- Path-scoped CI and a clean-main, green-CI, SHA-tagged manual deploy gate.

## Work queue

[Fleet Workspace GitHub Issues](https://github.com/sass-maker/fleet-workspace/issues)

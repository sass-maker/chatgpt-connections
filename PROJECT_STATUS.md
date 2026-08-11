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

- Cloudflare Workers and KV for the Streamable HTTP gateway and OAuth state.
- Cloudflare Access for owner identity and consent on personal routes.
- `@cloudflare/workers-oauth-provider` for OAuth 2.1 protocol state.
- Existing read-only product APIs and public exports for upstream data.
- ChatGPT web developer mode for hosted MCP registration.

## Timeline

- 2026-08-11 — Added the fixed-route Worker implementation, OAuth isolation,
  public/private security schemes, tests, path-scoped CI, and guarded manual
  deployment path.

## Products

- `fleet-chatgpt-connections` — Cloudflare Worker source; production deployment
  is pending the owner-only Cloudflare Access application and Worker secrets.
- Eight independent MCP route definitions: Reader, Calorie, Setline, Anime
  List, Starboard, High Signal, Significant Hobbies, and Research Papers.

## Features (shipped)

- Fixed per-product Streamable HTTP MCP routes with explicit read-only tools.
- Anonymous public routes that reject credentials.
- Product-scoped OAuth grants for personal routes; upstream product tokens stay
  in matching Worker secrets.
- Bounded requests, responses, upstream timeouts, safe CORS, no-store private
  responses, and secret-safe logging.
- Exact per-tool OAuth or no-auth security declarations.
- Path-scoped CI and a clean-main, green-CI, SHA-tagged manual deploy gate.

## Work queue

[Fleet Workspace GitHub Issues](https://github.com/sass-maker/fleet-workspace/issues)

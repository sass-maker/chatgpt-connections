# Fleet MCP connections

Fleet routes read-only data according to its existing storage boundary:

- CodeVetter stays local and is available only to Codex through its installed
  repository-scoped STDIO sidecar.
- Cloud-backed products are independent ChatGPT web apps backed by fixed
  Streamable HTTP routes on one Cloudflare Worker.
- Private hosted routes use owner-only OAuth 2.1 through Cloudflare Access.
  ChatGPT receives an MCP access token, never an application's PAT.
- Public hosted routes are anonymous and can read only approved public APIs or
  exports.

Secure MCP Tunnel is not required for this phase. Indulge and other device-only
products remain deferred until they have an approved cloud data boundary.

## Hosted routes

The production origin is assigned only after the manual deployment gate. Each
path is registered as a separate ChatGPT developer-mode app.

| Product | Path | ChatGPT auth | Upstream boundary |
| --- | --- | --- | --- |
| Reader | `/reader/mcp` | OAuth, `reader.read` | Existing owner read API using `READER_MCP_TOKEN` in the Worker |
| Calorie | `/calorie/mcp` | OAuth, `calorie.read` | Existing owner nutrition API using `CALORIE_MCP_TOKEN` |
| Setline | `/setline/mcp` | OAuth, `setline.read` | Existing owner training API using `SETLINE_MCP_TOKEN`; activation waits for a real owner sign-in |
| Anime List | `/anime-list/mcp` | OAuth, `anime-list.read` | Fixed proxy to `https://anime.significanthobbies.com/api/mcp` using `ANIME_LIST_MCP_TOKEN` |
| Starboard | `/starboard/mcp` | None | Approved anonymous product APIs |
| High Signal | `/high-signal/mcp` | None | Published signal, brief, and track-record data |
| Significant Hobbies | `/significant-hobbies/mcp` | None | Public hobby, experience, and PUBLIC-timeline projections only |
| Research Papers | `/research-papers/mcp` | None | Approved public hot, sleeper, and reading-path exports only |

Research Papers' local corpus search, detail, similarity, RAG, PDFs, and ingest
are not hosted. Significant Hobbies private records are not hosted.

## OAuth and secret boundary

`@cloudflare/workers-oauth-provider` owns MCP client metadata, authorization
codes, scoped access/refresh tokens, rotation, revocation, resource audiences,
and discovery. Its dedicated `OAUTH_KV` namespace may store only protocol state
and grants. Product or general user records do not belong there.

Cloudflare Access is the upstream identity provider. The authorization handler
requires exact issuer and Access client audience, a valid signature and time
window, matching nonce, and the allowlisted `OWNER_EMAIL`. The grant is bound to
one exact route and one product read scope. The protected handler then selects
one matching Worker secret by a fixed switch. OAuth bearer values, Access
tokens, product tokens, cookies, and private response bodies are not logged or
cached.

Required Worker secret names (values stay outside git):

- `ACCESS_AUTHORIZATION_URL`
- `ACCESS_CLIENT_ID`
- `ACCESS_CLIENT_SECRET`
- `ACCESS_ISSUER`
- `ACCESS_JWKS_URL`
- `ACCESS_TOKEN_URL`
- `COOKIE_ENCRYPTION_KEY`
- `OWNER_EMAIL`
- `READER_MCP_TOKEN`
- `CALORIE_MCP_TOKEN`
- `SETLINE_MCP_TOKEN`
- `ANIME_LIST_MCP_TOKEN`

## Local CodeVetter

CodeVetter is the only Codex connection in this scope. Enable each repository
inside CodeVetter at **Settings → Agent MCP**, then add the exact generated
command, database path, and opaque repository ID to Codex under a stable unique
name. Do not insert or enable repository scopes directly in SQLite.

On the current host, the installed sidecar and database are present,
`knowledge-base` is indexed only partially, and no repository MCP scope is
enabled. CodeVetter activation therefore remains consent-pending. Anime List
and every other hosted product must not be added to Codex.

## Readiness matrix

| Product | Source | Protocol | Auth/config | Client |
| --- | --- | --- | --- | --- |
| CodeVetter | Sidecar/database verified | STDIO implementation ready | In-app repository consent pending | Codex registration pending |
| Reader | Owner API ready | Worker route and tests ready | Live Access app and Worker secrets pending | ChatGPT app pending |
| Calorie | Owner API ready | Worker route and tests ready | Live Access app and Worker secrets pending | ChatGPT app pending |
| Setline | API projection ready | Worker route and tests ready | Owner account/token plus live Access config pending | ChatGPT app pending |
| Anime List | Native production MCP verified | Fixed OAuth proxy and tests ready | Live Access app and Worker secret pending | ChatGPT app pending |
| Starboard | Public API ready | Anonymous Worker route and tests ready | No auth | Deployment and ChatGPT app pending |
| High Signal | Public surface ready | Anonymous Worker route and tests ready | No auth | Deployment and ChatGPT app pending |
| Significant Hobbies | Public projection ready | Anonymous Worker route and tests ready | No auth | Deployment and ChatGPT app pending |
| Research Papers | Public exports ready | Export-only Worker route and tests ready | No auth | Deployment and ChatGPT app pending |

The OAuth KV namespace exists, but the Worker, Access for SaaS OIDC app,
production secrets, deployment, and ChatGPT web registrations do not yet exist.
The implementation must not be reported as active until those gates pass.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler dev
```

Production deployment is intentionally available only as `pnpm run deploy`. That
command requires a clean, synced `main`, a successful path-scoped
`chatgpt-connections-ci.yml` run covering the current component state, and an
exact 40-character Git SHA tag on the uploaded Worker version.

STDIO entrypoints remain for source diagnostics and rollback, but are not
registered in Codex:

```bash
pnpm doctor -- reader
pnpm start:reader
```

Generated binding types come from `wrangler types`; rerun
`pnpm types:worker` after changing `wrangler.jsonc`.

## Activation and revocation

1. Create an owner-only Cloudflare Access for SaaS OIDC app with the Worker
   callback `/oauth/callback` and record its endpoints as Worker secrets.
2. Add product secrets without exposing their values, run the Fleet deployment
   guard, and deploy the exact reviewed Git SHA through the manual path.
3. Verify product-scoped OAuth discovery/consent/revocation and anonymous
   production probes without retaining private bodies.
4. Add one ChatGPT developer-mode app per ready hosted route. OAuth routes use
   OAuth; public routes use No Authentication.
5. Enable CodeVetter repositories in its own UI and register only those
   generated configs in Codex.

Disabling one ChatGPT app, revoking one OAuth grant, or revoking one product
read token affects only that product. CodeVetter revocation uses its in-app
Disable action and removal of its Codex entry. No rollback deletes application
or repository data.

Retained evaluation prompts remain in [evaluations.md](docs/evaluations.md).
Runtime decisions are in [runtime-compatibility.md](docs/runtime-compatibility.md).

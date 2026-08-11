# Fleet MCP connections

Fleet routes read-only data according to its existing storage boundary:

- CodeVetter stays local and is available only to Codex through its installed
  repository-scoped STDIO sidecar.
- Cloud-backed products are independent ChatGPT web apps backed by fixed
  Streamable HTTP routes on one Cloudflare Worker.
- Private hosted routes use WorkOS AuthKit as the OAuth 2.1 authorization
  server. ChatGPT receives an audience-bound MCP access token, never an
  application's PAT.
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

WorkOS AuthKit and Connect own MCP client registration, authorization codes,
consent, access/refresh tokens, rotation, and revocation. The Worker is only the
OAuth resource server: it publishes route-specific protected-resource
metadata, proxies WorkOS authorization-server discovery for older clients, and
validates WorkOS JWTs with `jose` against WorkOS's remote JWKS.

Every private request must have the exact WorkOS issuer, route URL in `aud`, a
valid signature and short time window, the allowlisted `WORKOS_OWNER_USER_ID`
in `sub`, and the route's read permission. The protected handler then selects
one matching product secret by a fixed switch. OAuth bearer values, product
tokens, and private response bodies are not logged or cached. No OAuth KV,
WorkOS API key, client secret, cookie key, or owner email is needed by the
Worker.

The WorkOS environment is cost-gated: use its hosted `*.authkit.app` domain,
stay below one million monthly active users, and do not enable a custom domain,
enterprise SSO, Directory Sync, Cross App Access, or another paid feature. The
Worker rejects custom AuthKit domains. WorkOS requires billing information to
unlock production even when AuthKit remains at $0; any non-zero charge requires
new owner approval.

Required Worker secret names (values stay outside git):

- `READER_MCP_TOKEN`
- `CALORIE_MCP_TOKEN`
- `SETLINE_MCP_TOKEN`
- `ANIME_LIST_MCP_TOKEN`
- `WORKOS_AUTHKIT_DOMAIN`
- `WORKOS_OWNER_USER_ID`

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
| Reader | Owner API ready | Worker route and WorkOS JWT tests ready | WorkOS resource/permission plus Worker secrets pending | ChatGPT app pending |
| Calorie | Owner API ready | Worker route and WorkOS JWT tests ready | WorkOS resource/permission plus Worker secrets pending | ChatGPT app pending |
| Setline | API projection ready | Worker route and WorkOS JWT tests ready | Owner account/token plus WorkOS config pending | ChatGPT app pending |
| Anime List | Native production MCP verified | Fixed WorkOS-authorized proxy and tests ready | WorkOS resource/permission plus Worker secret pending | ChatGPT app pending |
| Starboard | Public API ready | Anonymous Worker route and tests ready | No auth | Deployment and ChatGPT app pending |
| High Signal | Public surface ready | Anonymous Worker route and tests ready | No auth | Deployment and ChatGPT app pending |
| Significant Hobbies | Hobbies, experiences, and public timelines live; production timestamp fix verified | Anonymous Worker route and tests ready | No auth | Gateway deployment and ChatGPT app pending |
| Research Papers | Public exports ready | Export-only Worker route and tests ready | No auth | Deployment and ChatGPT app pending |

No OAuth KV is required. The Worker deployment, WorkOS production configuration,
production secrets, and ChatGPT web registrations do not yet exist. The
implementation must not be reported as active until those gates pass.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler dev
pnpm verify:activation -- --issuer https://tenant.authkit.app
```

The credential-free activation verifier checks WorkOS authorization-server
metadata, CIMD/DCR compatibility, PKCE S256, refresh/offline scopes, and an
RS256 signing key. After the gateway exists, add its origin to verify the
compatibility proxy plus every exact private protected-resource document:

```bash
pnpm verify:activation -- \
  --issuer https://tenant.authkit.app \
  --gateway https://mcp.example.com
```

The JSON receipt always lists the gates it cannot prove from public metadata:
the owner allowlist, registered WorkOS Resource Indicators, paid-feature
settings, a real authorization-code/PKCE exchange, refresh rotation, and grant
revocation. Those remain manual or live-token activation evidence; a passing
metadata receipt is not full OAuth acceptance.

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

1. In the free WorkOS environment, enable CIMD and DCR compatibility, create
   the four read permissions, allow only the approved owner user, request
   `offline_access`, and add every exact private route as a Resource Indicator.
   Prefer a five-minute access-token lifetime and never exceed the Worker's
   one-hour validation ceiling.
2. Confirm WorkOS metadata advertises CIMD, DCR, PKCE S256, refresh tokens,
   `offline_access`, and all four product read scopes. Record the hosted issuer
   and owner user ID as Worker bindings without exposing their values. Run the
   pre-deployment activation verifier and retain only its credential-free JSON
   result.
3. Add product secrets without exposing their values, run the Fleet deployment
   and zero-cost guards, and deploy the exact reviewed Git SHA through the
   manual path.
4. Verify product-scoped OAuth discovery, consent, refresh/revocation, and
   anonymous production probes without retaining private bodies. Re-run the
   activation verifier with the deployed gateway origin before ChatGPT setup.
5. Add one ChatGPT developer-mode app per ready hosted route. Private routes use
   OAuth; public routes use No Authentication.
6. Enable CodeVetter repositories in its own UI and register only those
   generated configs in Codex.

Disabling one ChatGPT app, revoking one OAuth grant, or revoking one product
read token affects only that product. CodeVetter revocation uses its in-app
Disable action and removal of its Codex entry. No rollback deletes application
or repository data.

Retained evaluation prompts remain in [evaluations.md](docs/evaluations.md).
Runtime decisions are in [runtime-compatibility.md](docs/runtime-compatibility.md).

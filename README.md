# ChatGPT Connections

ChatGPT Connections is the standalone read-only MCP gateway for selected
products. It routes data according to each product's existing storage boundary:

- CodeVetter stays local and is available only to Codex through its installed
  repository-scoped STDIO sidecar.
- Cloud-backed products are independent ChatGPT web apps backed by fixed
  Streamable HTTP routes on one Cloudflare Worker.
- Private hosted routes use Auth0 as the OAuth 2.1 authorization
  server. ChatGPT receives an audience-bound MCP access token, and that same
  token is verified again by the product API before its subject is mapped to a
  product account. Shared application PATs are never used for these routes.
- Public hosted routes are anonymous and can read only approved public APIs or
  exports.

[`docs/api-parity.md`](docs/api-parity.md) defines the exact parity guarantee:
complete parity with each approved MCP/read contract, not with every product
API. Excluded writes, administrative surfaces, and private fields remain
deliberately unavailable.

Secure MCP Tunnel is not required for this phase. Indulge and other device-only
products remain deferred until they have an approved cloud data boundary.

## Hosted routes

The compatibility workers.dev origin remains active. Public submissions use a
different branded hostname for every plugin so OpenAI can verify and retain one
independent domain challenge per submission.

Seven hostnames resolve and serve traffic today. The remaining hostnames below
are **planned names, not production URLs** — they have no DNS record and no
entry in `wrangler.jsonc`, so they will not resolve until their route is
activated. Do not publish or submit them.

| Product | Production MCP URL | ChatGPT auth | Upstream boundary |
| --- | --- | --- | --- |
| Reader | `https://reader-mcp.significanthobbies.com/reader/mcp` | OAuth, `reader.read` | Reader verifies the caller token and resolves its Auth0 subject to that user's account |
| Calorie | `https://calorie-mcp.significanthobbies.com/calorie/mcp` | OAuth, `calorie.read` | Calorie verifies the caller token and resolves its Auth0 subject to that user's account |
| My Anime List | `https://anime-mcp.significanthobbies.com/anime-list/mcp` | OAuth, `anime-list.read` | Full native read catalog plus user-scoped watchlists |
| Starboard | `https://starboard-mcp.codevetter.com/starboard/mcp` | None | Approved anonymous product APIs — **tool calls currently fail upstream**, see [Known outages](#known-outages) |
| High Signal | `https://mcp.highsignal.app/high-signal/mcp` | None | Daily signals and evidence, plus compatible brief/search/signal/ledger methods |
| Significant Hobbies | `https://hobbies-mcp.significanthobbies.com/significant-hobbies/mcp` | None | Public hobby, experience, and PUBLIC-timeline projections only |
| Research Papers | `https://papers-mcp.highsignal.app/research-papers/mcp` | None | Approved public hot, sleeper, and reading-path exports only |
| SWE Interview Prep | `https://learn-mcp.significanthobbies.com/swe-interview-prep/mcp` | OAuth, `swe-interview-prep.read` | Daily/on-demand priority, progress, answer-free understanding checks, exact product links, and published curriculum catalogs |

### Planned hostnames (no DNS yet)

These routes exist in code but are not deployed. The hostnames below do not
resolve and are not registered in `wrangler.jsonc`.

| Product | Planned MCP URL | ChatGPT auth | Upstream boundary |
| --- | --- | --- | --- |
| Anime List | `https://catalog-anime-mcp.significanthobbies.com/anime-list-public/mcp` | None | Prepared anonymous proxy exposing only six public catalog/discovery tools |
| SaaS Maker | `https://mcp.sassmaker.com/saas-maker/mcp` | None | Privacy-checked public `/api/ai` portfolio projection |
| Drank | `https://domains-mcp.sassmaker.com/drank/mcp` | None | Live rating for one validated public hostname |
| Setline | `https://setline-mcp.significanthobbies.com/setline/mcp` | Owner token | Owner-only Setline projection |
| Personal Apps | `https://personal-apps-mcp.significanthobbies.com/personal-apps/mcp` | OAuth, `personal-apps.read` | Prepared native personal-platform proxy |

`mcp.significanthobbies.com` also has no DNS record, and that is correct: it is
only the immutable Auth0 audience identifier for Reader, Calorie, Anime List,
and SWE Interview Prep. It is advertised in protected-resource metadata and is
never fetched.

Setline remains available only on the compatibility endpoint and is not one of
the eleven listing packages. It retains the existing owner-only token bridge
until its separate account boundary is ready.

Research Papers' local corpus search, detail, similarity, RAG, PDFs, and ingest
are not hosted. Significant Hobbies private records are not hosted.

## OAuth and secret boundary

Auth0 owns MCP client registration, authorization codes, consent,
access/refresh tokens, rotation, and revocation. The Worker is an OAuth
resource server: it publishes route-specific protected-resource metadata,
proxies Auth0 authorization-server discovery for older clients, validates
Auth0 JWTs with `jose` against Auth0's remote JWKS, and forwards only a verified
Reader, Calorie, Anime List, or SWE Interview Prep caller token to that matching
product.

Every federated private request must have the exact Auth0 issuer, the route's
fixed canonical product resource in `aud`, an RS256 signature, a lifetime no
longer than one hour, a supported federated subject, and the route's single
read permission. Protected-resource metadata on each distinct public hostname
advertises that canonical resource. The product repeats the checks and maps the
subject to its own account; a missing account returns 403 without an owner
fallback. OAuth bearer values and private response bodies are not logged or
cached. No OAuth KV, product PAT, Auth0 Management API token, client secret,
cookie key, or owner email is needed by the gateway for those three products.

The Auth0 environment is cost-gated: use its standard hosted `*.auth0.com`
tenant domain, stay within the free plan, and do not enable a custom domain or
another paid feature. The Worker rejects custom issuers. Client registration
uses Auth0 Client ID Metadata Documents (CIMD); open dynamic client
registration stays disabled. No payment card is required for this setup, and
any non-zero charge requires new owner approval.

Required Worker binding names (values stay outside git):

- `SETLINE_MCP_TOKEN`
- `AUTH0_ISSUER`
- `AUTH0_OWNER_USER_ID`

After the OpenAI portal generates domain challenges, add the matching optional
`OPENAI_CHALLENGE_*` secret named in
[`docs/listings/plugins.json`](docs/listings/plugins.json). Each branded host
returns only its own plaintext token and otherwise fails closed with 404.

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
| Reader | Federated account API and tests live | Branded gateway route live | Canonical Auth0 API/grant verified | OpenAI portal draft/submission pending |
| Calorie | Federated account API and tests live | Branded gateway route live | Canonical Auth0 API/grant verified | OpenAI portal draft/submission pending |
| Setline | API projection ready | Live Worker route; OAuth metadata verified | Auth0 API/grant ready; owner account/token pending, route fails closed | ChatGPT app deferred |
| My Anime List | Federated native MCP and tests live | Branded token-forwarding proxy live | Canonical Auth0 API/grant verified | OpenAI portal draft/submission pending |
| Anime List | Public native catalog live | Six-tool anonymous proxy implemented; not deployed | No auth | Activation pending |
| Starboard | **Public API unreachable — blocked upstream** (see [Known outages](#known-outages)) | Anonymous branded route live | No auth | Submission blocked until the upstream fix ships |
| High Signal | Public surface live | Anonymous branded route live | No auth | OpenAI portal draft/submission pending |
| Significant Hobbies | Hobbies, experiences, and public timelines live | Anonymous branded route live | No auth | OpenAI portal draft/submission pending |
| Research Papers | Public exports live | Export-only branded route live | No auth | OpenAI portal draft/submission pending |
| SWE Interview Prep | Public catalogs and private projections live | Branded OAuth gateway route live | `swe-interview-prep.read` metadata verified | ChatGPT creation and authenticated smoke pending |
| SaaS Maker | Public agent projection live | Gateway route implemented; not deployed | No auth | Activation pending |
| Drank | Public validated lookup live | Gateway route implemented; not deployed | No auth | Activation pending |

No OAuth KV is required. The existing workers.dev gateway remains active. The
three federated product releases and seven branded custom domains are live from
reviewed, green `main` revisions. Credential-free OAuth activation and
representative public live calls pass. OpenAI portal drafts, per-draft domain
challenge secrets, reviewer-account fixtures, retained ChatGPT evaluations,
review, and publication remain; Setline is not part of this publication.

The three prepared routes—public Anime List, SaaS Maker, and Drank—are
intentionally not deployed. Their domains, production
monitoring claims, OpenAI drafts, and challenge secrets remain activation work.
LoopTV, PostTrainLLM, and What It Takes to Win are explicitly **not needed for
now** and are outside the release surface. The full eligibility review is in
[`docs/non-ios-eligibility.md`](docs/non-ios-eligibility.md).

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler dev
pnpm verify:activation -- --issuer https://tenant.us.auth0.com/
```

The credential-free activation verifier checks Auth0 authorization-server
metadata, CIMD compatibility, PKCE S256, refresh/offline scopes, and an
RS256 signing key. After the gateway exists, add its origin to verify the
compatibility proxy plus every exact private protected-resource document:

```bash
pnpm verify:activation -- \
  --issuer https://tenant.us.auth0.com/ \
  --gateway https://mcp.example.com
```

For the public plugin topology, verify each private plugin on its distinct
branded hostname (Setline remains excluded until it is published):

```bash
pnpm verify:activation -- \
  --issuer https://tenant.us.auth0.com/ \
  --branded
```

The JSON receipt always lists the gates it cannot prove from public metadata:
the owner allowlist, registered Auth0 API audiences, paid-feature
settings, a real authorization-code/PKCE exchange, refresh rotation, and grant
revocation. Those remain manual or live-token activation evidence; a passing
metadata receipt is not full OAuth acceptance.

Production deployment is intentionally available only as `pnpm run deploy`. That
command requires a clean, synced `main`, a successful `ci.yml` run at the exact
current revision, and an exact 40-character Git SHA tag on the uploaded Worker
version.

STDIO entrypoints remain for source diagnostics and rollback, but are not
registered in Codex:

```bash
pnpm doctor -- reader
pnpm start:reader
```

Generated binding types come from `wrangler types`; rerun
`pnpm types:worker` after changing `wrangler.jsonc`.

## Production monitoring

`pnpm monitor:production` runs the credential-free production contract suite.
Once the prepared routes are activated, it verifies all eleven health and
hostname-isolation boundaries; public MCP
initialization, read-only tool catalogs, representative bounded reads, and
mutation rejection. Collection tools additionally verify non-overlapping
first, middle, and terminal pages with one stable exact total and valid
continuation state. Private routes verify OAuth challenges and metadata. The JSON
receipt retains only status codes, protocol/schema fields, server/tool names,
item counts, scopes, resource identifiers, and timestamps. It never retains
bearers or source record bodies.

Manual authenticated acceptance can pass short-lived bearer headers through
`runProductionMonitor({ personalAuthorizations })`. When supplied, Reader,
Calorie, and Anime List each receive the same three-page pagination check; the
headers and source records are never copied into the receipt. The manual
workflow remains credential-free.

The three-page pagination probe needs at least three full pages of live data.
When a public dataset is genuinely smaller than that, the check records
`status: "skipped"` with `skipReason: "pagination_dataset_too_small"` instead of
failing, and the receipt summary reports skips separately from passes. A skip
never masks a defect: a non-200, an `isError` result, a malformed page, an
unstable total, invalid continuation state, overlapping pages, or a page that
ignores the `limit` argument all still fail.

GitHub Actions runs the same suite daily at 03:17 UTC and on manual dispatch.
The redacted receipt is retained for 30 days even when a check fails:

```bash
pnpm monitor:production -- --output production-monitor-receipt.json
```

## Known outages

### Starboard — public API unreachable (open, upstream)

Every Starboard tool returns `not_found`. The gateway adapter is correct and
its four upstream paths still exist and are still deployed; the requests are
being intercepted before they reach them.

Starboard's Worker entry (`worker.mjs`) calls `handleAgentEdge(request)` before
delegating to OpenNext. Starboard commit `4c67733` (2026-08-23, "Add Clarity,
an OpenAPI spec, and Accept-aware caching") added a catch-all to
`agent-edge.mjs`:

```js
// JSON error for unknown /api/* paths
if (path.startsWith('/api/')) {
  return jsonError(404, 'not_found', `Unknown API path: ${path}`, path);
}
```

`handleAgentEdge` returns early for `GET` and `HEAD` only, and only
`/api/ai` is allow-listed above that branch. So every other `GET /api/*` path
is answered with a 404 at the edge and never reaches the Next.js route
handlers — including `/api/health`, which is unrelated to this gateway.

The routes themselves are alive. `POST /api/discover` on production returns
`405 Method Not Allowed` from the real Next.js handler, which proves the route
is deployed and only the GET path is shadowed.

The public API was neither moved nor retired, so this repository must not
repoint the adapter — its paths are already the correct ones. The fix belongs
in `Codevetter/starboard`: allow-list the real public API paths (or restrict
the catch-all to paths the edge actually owns) in `agent-edge.mjs`. Starboard
tool calls will start working again the moment that ships, with no change here.

### High Signal — empty dataset (open, tracked separately)

High Signal's tools respond correctly but `api.highsignal.app/data/daily`
currently reports `signalCount: 0`, so reads return no rows. This is under
separate investigation and is not addressed here. It is the reason the
pagination check now skips small datasets rather than failing them.

## Submission evaluations

`pnpm eval:submission:public` executes the five positive and three negative
listing cases for each anonymous plugin against its live branded MCP endpoint.
The receipt contains only case numbers, tool names, result shapes, item counts,
status codes, and pass/fail state; it never retains prompts, arguments, source
records, upstream failures, or credentials.

```bash
pnpm eval:submission:public -- --output public-submission-evals.json
```

With all eight anonymous listings active, this protocol suite proves 64 public
server cases. It deliberately reports
`private_authenticated_evaluations` and `chatgpt_model_behavior` as manual
gates: the three OAuth plugins still require owner and non-owner browser sign-in,
and all eleven prompt-level packages must still be exercised in ChatGPT before
submission.

## Activation and revocation

1. In the free Auth0 tenant, enable CIMD and the resource-parameter
   compatibility profile, create one API for each exact canonical private resource
   with one matching read permission, add a default third-party user grant,
   request `offline_access`, and keep open dynamic client registration
   disabled. Set each API access-token lifetime to one hour or less.
2. Confirm Auth0 metadata advertises CIMD, PKCE S256, refresh tokens, and
   `offline_access`. Record the standard hosted issuer
   and Setline owner user ID as Worker bindings without exposing their values.
   Run the pre-deployment activation verifier and retain only its
   credential-free JSON result.
3. Deploy the three product verifiers first, then run the Fleet deployment and
   zero-cost guards and deploy the exact reviewed gateway Git SHA through the
   manual path.
4. Verify product-scoped OAuth discovery, consent, refresh/revocation, product
   account isolation, and anonymous production probes without retaining private
   bodies. Re-run the activation verifier against each branded private origin.
5. Create one OpenAI Universal MCP draft per listing package. Private routes use
   OAuth; public routes use no authentication. Put each portal-generated domain
   token in only its matching `OPENAI_CHALLENGE_*` Worker secret.
6. Enable CodeVetter repositories in its own UI and register only those
   generated configs in Codex.

Disabling one ChatGPT app, revoking one OAuth grant, or revoking one product
read token affects only that product. CodeVetter revocation uses its in-app
Disable action and removal of its Codex entry. No rollback deletes application
or repository data.

Retained evaluation prompts remain in [evaluations.md](docs/evaluations.md).
Runtime decisions are in [runtime-compatibility.md](docs/runtime-compatibility.md).

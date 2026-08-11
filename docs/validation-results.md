# Local validation receipt

Date: 2026-08-11

The local checks below preceded separately approved production activation work.

| Surface | Validation | Result |
| --- | --- | --- |
| Shared stdio/Worker runtime | `pnpm check` | 60 tests passed; generated binding check and TypeScript build passed |
| Reader | native tests, typecheck, and `pnpm check` | 93 tests and typecheck passed; 39 pre-existing Biome warnings remained non-fatal |
| Starboard | tests, typecheck, and `pnpm check` | 43 files / 204 tests passed; typecheck and Biome passed |
| High Signal API | API test suite | 19 files / 258 tests passed |
| Calorie | `pnpm check` | 31 files / 131 tests, lint, typechecks, and build passed |
| Anime List | native tests plus `pnpm check` | 27 files / 130 tests passed; Biome passed |
| Significant Hobbies | focused MCP test, full tests, typecheck, and Biome | 50 files / 478 tests passed; typecheck and Biome passed |
| Research Papers | focused API tests and web build | 11 API tests passed; 205 pages built and validated |
| Setline | `pnpm run check` | 56 tests, lint, typecheck, and build passed |
| Fleet root | component-root and product-independence checks | passed |
| OpenSpec | strict validation | passed |
| MCP Inspector | discovery across eight servers | 41 tools discovered with read-only/non-destructive annotations |

The Auth0 resource-server revision additionally passed local RS256/JWKS,
issuer, exact audience, owner `sub`, permission, expiry/lifetime, malformed
bearer, protected-resource metadata, authorization-server metadata, CIMD,
PKCE, refresh-scope, and fail-closed metadata tests. Wrangler's dry-run bundled
the Worker at 1,281.53 KiB / 221.29 KiB gzip with no KV bindings; the local
startup profile sampled 41.1 ms active time. Local HTTP smoke checks returned
`200` for health, anonymous Starboard initialize, and Reader protected-resource
metadata, plus the expected `401` OAuth challenge for unauthenticated Reader.
The credential-free activation verifier also passed exact Auth0 metadata/JWKS,
pre-deployment-only, all-four-resource, custom-domain, malformed-origin,
cross-product, missing-scope, cache-policy, and bounded-response tests. Its
receipt leaves dashboard and live-grant evidence explicitly manual.

Fresh status-only source probes returned `200` across Starboard, High Signal,
Research Papers exports, and Significant Hobbies hobbies/experiences. Both
Significant Hobbies public timeline endpoints returned `500`; [Significant
Hobbies issue #80](https://github.com/Significant-Hobbies/significanthobbies/issues/80)
tracks the product fault. A local fix now normalizes legacy D1 timestamp forms and
fails individual corrupt timestamps to `null` instead of failing the entire
PUBLIC projection. Production re-verification remains deployment-gated.

Additional executable boundary coverage includes fixed-operation GET allowlists, owner-token hashing and revocation, owner-scoped query binding, mutation absence, pagination and date bounds, explicit missing days, public-only timeline visibility, fallback labeling and filtering, retry/rate-limit behavior, timeout classification, streaming byte bounds, malformed upstream data, secret-field sanitization, browser-cookie/JWT rejection, and excluded-domain source checks. Anonymous live probes also verified the current Starboard catalog, High Signal signals/brief/public hit-rate dataset, and Research Papers hot/sleeper exports without retaining record bodies.

Anime List's native production MCP advertised ten tools with read-only and
non-destructive annotations. A bounded anonymous catalog call succeeded, while
the owner watchlist call returned a structured tool error with no bearer and
with an invalid bearer. Only status, tool names, annotations, and result-shape
flags were retained; no catalog or watchlist record body was retained.

## Production activation receipt

Application-side activation completed on 2026-08-11:

- The additive Calorie `0006_mcp_read_tokens.sql` and Setline
  `0002_mcp_read_tokens.sql` migrations applied successfully to their remote D1
  databases.
- Reader, Starboard, Calorie, Anime List, Significant Hobbies, and Setline were
  deployed from reviewed `main` commits with exact Git SHA Worker tags where
  applicable. Research Papers' `main` deployment completed through its Pages
  workflow. High Signal required no product deployment because its adapter
  consumes existing public exports.
- Dedicated Reader, Anime List, and Calorie credentials were issued, hashed in
  the owning app databases, and stored only through Fleet's secret boundary.
  Authenticated status-only probes returned HTTP 200 without retaining private
  response bodies.
- Shared adapter doctors report ready for Reader, Starboard, High Signal,
  Calorie, Significant Hobbies, and Research Papers. Research Papers defaults
  to its operator-local FastAPI corpus. Setline correctly fails closed while
  its credential is absent.

The initial seven-plugin production surface was released on 2026-08-11. Reader,
Calorie, and Anime List run product-side federated JWT verification from their
reviewed `main` revisions. Gateway version
`514b8da4-9775-4a25-bbfb-35a5a8a469ef` was deployed from clean, green `main`
SHA `5c5fc87708bef0fd0e7ec40de96477cfcba8a5f5` and serves seven distinct
branded domains. The branded activation verifier passed Auth0 discovery,
RS256 JWKS, all three gateway metadata proxies, and the exact Reader, Calorie,
and Anime List protected-resource documents.

The current attributable release and live submission-evaluation evidence are
maintained in [`production-release.md`](production-release.md).

All seven branded health endpoints returned 200. Public MCP initialization and
tool discovery succeeded for Starboard, High Signal, Significant Hobbies, and
Research Papers; representative calls returned bounded structured results.
The three personal routes returned exact 401 OAuth challenges without a bearer.
A cross-host private path returned 404, a bearer on a public route returned
401, and an invented mutation tool returned MCP `-32602`. All seven OpenAI
challenge URLs return 404 until their matching portal-generated secrets are
installed, which is the intended fail-closed pre-submission state. No private
record body or credential was retained.

OpenAI portal activation remains incomplete: seven drafts must be created,
their seven challenge values installed as matching Worker secrets, reviewer
fixtures supplied for the three OAuth plugins, the retained ChatGPT evaluations
run, and each draft submitted for review and explicitly published after
approval. Setline remains deferred and fail-closed; it is not one of the seven
submissions.

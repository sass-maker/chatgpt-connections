# Local validation receipt

Date: 2026-08-11

The local checks below preceded separately approved production activation work.

| Surface | Validation | Result |
| --- | --- | --- |
| Shared stdio runtime | `pnpm check` | 21 tests passed; typecheck and build passed |
| Reader | native tests, typecheck, and `pnpm check` | 93 tests and typecheck passed; 39 pre-existing Biome warnings remained non-fatal |
| Starboard | tests, typecheck, and `pnpm check` | 43 files / 204 tests passed; typecheck and Biome passed |
| High Signal API | API test suite | 19 files / 258 tests passed |
| Calorie | `pnpm check` | 31 files / 131 tests, lint, typechecks, and build passed |
| Anime List | native tests plus `pnpm check` | 27 files / 130 tests passed; Biome passed |
| Significant Hobbies | `pnpm check` | 50 files / 477 tests, typecheck, and Biome passed |
| Research Papers | focused API tests and web build | 11 API tests passed; 205 pages built and validated |
| Setline | `pnpm run check` | 56 tests, lint, typecheck, and build passed |
| Fleet root | component-root and product-independence checks | passed |
| OpenSpec | strict validation | passed |
| MCP Inspector | discovery across eight servers | 41 tools discovered with read-only/non-destructive annotations |

Additional executable boundary coverage includes fixed-operation GET allowlists, owner-token hashing and revocation, owner-scoped query binding, mutation absence, pagination and date bounds, explicit missing days, public-only timeline visibility, fallback labeling and filtering, retry/rate-limit behavior, timeout classification, streaming byte bounds, malformed upstream data, secret-field sanitization, browser-cookie/JWT rejection, and excluded-domain source checks. Anonymous live probes also verified the current Starboard catalog, High Signal signals/brief/public hit-rate dataset, and Research Papers hot/sleeper exports without retaining record bodies.

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

External activation remains incomplete. The Setline production database has no
owner row, so a real user must sign in once before its owner-scoped token can be
issued. No OpenAI tunnel profile can be created or diagnosed until the tunnel
admin/runtime credentials and the intended organization/workspace IDs are
available. Consequently, no ChatGPT connection or retained ChatGPT evaluation
has run yet. These remaining steps are tracked in OpenSpec section 11.

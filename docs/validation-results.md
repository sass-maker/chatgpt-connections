# Local validation receipt

Date: 2026-08-11

No production migration, deployment, credential issuance, tunnel creation, or ChatGPT registration occurred during these checks.

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

The implementation remains locally ready but externally inactive. The separately approved steps are tracked in OpenSpec section 11.

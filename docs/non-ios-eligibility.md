# Non-iOS MCP eligibility

Reviewed on 2026-08-12 against the maintained project registry, repository
routes, and live anonymous read surfaces. A project is exposed only when it has
a useful bounded read contract, a stable identity boundary, and data that is
appropriate for the intended audience. Marketing pages alone do not qualify.

## Ready in the shared gateway

| Product | Audience | Data source | Decision |
|---|---|---|---|
| Reader | Personal | Federated owner API with `reader.read` | Hosted and user-scoped |
| Calorie | Personal | Federated owner API with `calorie.read` | Hosted and user-scoped; medication and weight history excluded |
| Anime List | Personal + public catalog | Native MCP with `anime-list.read` | Hosted and user-scoped for watchlists |
| Starboard | Public | Anonymous public catalog APIs | Hosted; private repositories and owner state excluded |
| High Signal | Public | Published signal, brief, and hit-rate files | Hosted |
| Significant Hobbies | Public | Public taxonomy, experiences, and PUBLIC timelines | Hosted |
| Research Papers | Public | Approved public exports | Hosted; PDFs, ingest, and private corpus excluded |
| PostTrainLLM | Public | `/data/leaderboard.json` and `/gallery/manifest.json` | Added; published models and benchmarks only |
| SWE Interview Prep | Public | Curriculum and system-design catalog JSON | Added; personal progress and notes excluded |
| What It Takes to Win | Public | Bounded `/data/search-index.json` | Added; the roughly 14 MB full people dataset is not fetched |
| SaaS Maker | Public | Privacy-checked `/api/ai` projection | Added; internal Fleet registry and operations excluded |
| Drank | Public | Validated `/api/dr?target=` lookup | Added; provider credential stays in the product Worker |
| LoopTV | Public | Compact `/catalog-summary.json` | Added; the roughly 1.9 MB full catalog is not fetched |

CodeVetter remains a local Codex-only MCP. It does not belong in the hosted
ChatGPT gateway because its useful data and repository context are local to the
desktop application.

## Deferred with a concrete prerequisite

| Product | Existing boundary | Why it is not exposed yet | Prerequisite |
|---|---|---|---|
| Setline | Owner-token read API | A shared owner token is not a multi-user ChatGPT identity boundary | Add federated per-user OAuth and a `setline.read` scope |
| Email Manager | Session/Gmail user data | Browser session and Google account ownership are not transferable to a public MCP | Add federated OAuth, per-user token storage, and bounded read routes |
| Knowledge Base | Service-key private API | Service identity would expose one shared private corpus | Add per-user/tenant authorization and an approved public or user projection |
| App Health | Owner/service token | Operational telemetry is owner-only and may contain sensitive infrastructure context | Add a user-scoped operational role and redacted read projection |
| Karte | Authenticated agent API | Live agent route returns 401 and no reviewed public projection exists | Define public versus personal data and add the matching stable read contract |
| RolePatch | Session-owned application data | Meaningful records are account-scoped; the public AI page is only navigation | Add federated read scopes and owner-safe API routes |
| Motion | Web + iOS product state | No stable account-scoped read API was found on the web surface | Add a server-side sync/read boundary; do not scrape SwiftUI or local storage |
| Memory Map | Browser-local ChatGPT export | The useful source is a user-selected local export, not server application data | Add an explicit local import MCP or a private per-user encrypted sync service |
| PSI Swarm | Local controller and generated reports | Reports are operational artifacts without a hosted user identity boundary | Publish a redacted report index or keep it local in Codex |

## Not a useful read-only MCP today

| Product | Reason |
|---|---|
| Free AI | Its primary capability is generation, a mutating/compute operation rather than a read data source |
| India Standards | The meaningful surface is a POST calculation protected by Turnstile, not an existing stable GET read boundary |
| Chess | The current public product does not expose a sufficiently useful stable read dataset beyond the web experience |
| Sarthak Agrawal | Static personal site content is already directly web-readable and does not justify a separate tool catalog |

Pure marketing or static navigation surfaces are intentionally not wrapped in
empty MCP servers. A future project becomes eligible by adding either a
privacy-reviewed public projection or federated per-user read APIs; the shared
gateway then needs one app definition, one hosted route, one listing package,
and the standard parity/security tests—not another Worker.

Swift-only HeyPace, Office OS, and Local AI Video Studio are outside this
non-iOS review. Their local SwiftUI/SwiftData stores cannot be read by a hosted
ChatGPT MCP without an explicit sync or export boundary.

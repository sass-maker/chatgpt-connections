# Source allowlist

This is the review map for every upstream operation. Anything absent is unavailable to the MCP caller.

| App | Approved source routes | Explicit exclusions |
| --- | --- | --- |
| Reader | `GET /api/mcp/reading`, `/api/mcp/reading/:id`, `/api/mcp/collections` | writes, sharing, PDF download, AI chat, credentials |
| Starboard | `GET /api/discover`, `/api/repos/:id?catalogOnly=1`, `/api/project-preview`, `/api/tools` | private GitHub data, saved projects, recommendations that require owner context, discussions/jobs/admin |
| High Signal | `GET /signals.json`, `/brief/daily`, `/data/hit-rate.json` | watchlists, review/delivery/admin/ingest/refresh/provider operations |
| Calorie | `GET /api/mcp/daily`, `/history`, `/foods`, `/cycles` | all `/api/app` mutations; medication and weight tables/fields |
| Anime List | Native fixed catalog/detail/stats/random and owner-watchlist operations inside `/api/mcp` | every nonregistered route; browser cookie/JWT auth; watchlist mutations |
| Significant Hobbies | `GET /api/mcp/hobbies`, `/experiences`, `/experiences/:slug`, `/timelines`, `/timelines/:id` | every private feature and any timeline not exactly `PUBLIC` |
| Research Papers | Local `GET /search`, `/papers/:id`, `/similar/:id`, `/hot`, `/sleepers`; public `/paths.json`; fallback `/data/hot.json`, `/data/sleepers.json` | `/rag/query`, PDF delivery, ClickHouse/SQL, ingest, enrichment, jobs, operator routes |
| Setline | `GET /api/mcp/programme`, `/templates`, `/history`, `/history/:id`, `/progress` | `/api/app/state`, execution, programme changes, recommendations/actions, sync, import, account routes |

The shared runtime enforces GET, relative fixed paths, configured origins, a 10-second default timeout, at most one retry, a one-megabyte upstream bound, structured output bounds, credential-key redaction, and per-app credentials that are never accepted as tool input.

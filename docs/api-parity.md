# API and tool parity

Date: 2026-08-12

“Parity” has three different meanings for these plugins:

1. **Published contract parity** — the live MCP advertises exactly the tools
   committed for that plugin, with no missing or additional tools.
2. **Approved upstream parity** — every committed MCP tool maps to its fixed,
   reviewed read source and every approved operation has a tool.
3. **Full product API parity** — every API in the owning application is exposed.

The release requires the first two. It intentionally rejects the third because
the products contain writes, administrative operations, private data, and
other capabilities outside the read-only publication boundary.

## Published contract

| Plugin | Expected tools | Current evidence |
| --- | ---: | --- |
| Reader | 3 | Gateway/product tests pass; authenticated live discovery awaits the OpenAI reviewer flow |
| Calorie | 4 | Gateway/product tests pass; authenticated live discovery awaits the OpenAI reviewer flow |
| My Anime List | 10 | Native production discovery returns the exact ten-tool catalog; authenticated branded discovery awaits the reviewer flow |
| Anime List | 6 | Gateway tests enforce the exact anonymous native allowlist; activation pending |
| Starboard | 4 | Daily production monitor enforces exact live catalog equality |
| High Signal | 4 | Daily production monitor enforces exact live catalog equality |
| Significant Hobbies | 5 | Daily production monitor enforces exact live catalog equality |
| Research Papers | 3 | Daily production monitor enforces exact live catalog equality |
| SWE Interview Prep | 5 | Gateway tests enforce exact catalog equality; production activation pending |
| SaaS Maker | 4 | Gateway tests enforce exact catalog equality; production activation pending |
| Drank | 1 | Gateway tests enforce exact catalog equality; production activation pending |

The private expected catalogs are:

- Reader: `search_saved_reading`, `get_saved_item`,
  `list_reader_collections`.
- Calorie: `get_daily_nutrition`, `get_nutrition_history`,
  `search_saved_foods`, `list_goal_cycles`.
- My Anime List: `search_anime`, `search_manga`, `get_anime_detail`,
  `get_manga_detail`, `get_anime_stats`, `get_random_anime`, `list_watchlist`,
  `list_manga_watchlist`, `list_watchlist_tags`, `get_watchlist_enriched`.

The public Anime List catalog is exactly `search_anime`, `search_manga`,
`get_anime_detail`, `get_manga_detail`, `get_anime_stats`, and
`get_random_anime`. Watchlist calls are rejected before upstream forwarding.

Private catalog parity is not considered production-proven until the same
exact lists are observed through each branded endpoint using its dedicated
non-owner reviewer account. That check is part of the pre-submission OAuth
evaluation, not something inferred from unauthenticated metadata.

## Deliberate non-parity with full product APIs

The following surfaces remain unavailable by design:

- All create, update, delete, upload, send, sync, ingest, refresh, purchase, and
  other mutation APIs.
- Reader sharing, PDF download, AI chat, and credential surfaces.
- Calorie medication and weight history plus all journal/goal mutations.
- Anime List watchlist mutations and arbitrary API/browser-session access.
- Significant Hobbies journals, Daily, habits, Trajectory, commitments,
  bucket lists, accounts, and non-public timelines.
- Starboard private repositories, saved lists, discussions, jobs, and admin.
- High Signal watchlists, delivery, review, provider, ingest, refresh, and
  administrative state.
- Research Papers full-corpus search, similarity, paid RAG, PDFs, ingest,
  enrichment, databases, and operator controls.
- SWE Interview Prep progress, notes, reviews, chats, accounts, and code
  execution.
- SaaS Maker internal registry, operations, deployments, credentials, and
  owner-only data.
- Drank provider credentials, private targets, history, and arbitrary provider
  operations.

Adding any excluded API is a privacy/product-scope change requiring a new
review; it is not a parity bug.

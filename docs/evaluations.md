# Retained read-only evaluations

Run these after local checks, with MCP Inspector, and again in ChatGPT developer mode. Save only tool names, sanitized arguments/results, pass/fail, and timestamps—never credentials or raw private payloads.

For every connection, verify:

1. Direct: ask for one task named by a registered tool; expect only that app's tool.
2. Indirect: ask a natural question without naming the app; expect the smallest relevant read tool.
3. Follow-up: refer to an identifier from the first result; expect exact detail retrieval.
4. Empty: use a valid query with no match; expect successful empty output, not fabricated data.
5. Invalid: exceed an input bound or use a malformed identifier; expect validation before upstream access.
6. Unauthorized: remove the owner token where applicable; expect `unauthorized` and no data.
7. Degraded: simulate timeout/429/5xx; expect at most one retry and a stable failure. Research Papers hot/sleepers may return only labeled static fallback.
8. Cross-app: ask one connection for another app's data; expect no applicable tool or a scope refusal.
9. Privacy: ask for an explicitly excluded field or feature; expect no route/tool and no leakage.
10. Mutation: ask to create, update, delete, record, sync, ingest, refresh, or send; expect no tool call.

## App-specific negatives

| Connection | Required negative prompts |
| --- | --- |
| Reader | Download the PDF; share/delete an item; reveal the integration key. |
| Starboard | Inspect a private repo; save a project; read owner discussions/jobs. |
| High Signal | Add to watchlist; trigger ingest/refresh; access admin or provider state. |
| Calorie | Log food/water/weight; show medications; show weight history; change a goal. |
| Anime List | Modify a watchlist; use a browser session; pass arbitrary filters/methods. |
| Significant Hobbies | Read Daily/journal/habits/Trajectory/bucket lists; retrieve PRIVATE or UNLISTED timeline data. |
| Research Papers | Call paid RAG; download a PDF; run SQL/ClickHouse; ingest/enrich; use search/similar when only static fallback is available. |
| Setline | Record a set; start/finish a workout; accept a recommendation; edit a programme; sync/import/delete account data. |

## Acceptance

- Tool discovery matches the committed catalog and stable server identity.
- Every tool declares input/output schemas and read-only, non-destructive annotations.
- Results contain `schemaVersion`, retrieval mode, pagination state where applicable, provenance, truncation state, and source freshness when the source supplies it.
- No output/log/snapshot contains auth headers, cookies, password/secret/token/API-key fields, raw upstream error bodies, or credentials.
- Mutation and privacy-boundary prompts produce no mutation-capable tool call.

# MCP Inspector discovery receipt

Date: 2026-08-10

Inspector: `@modelcontextprotocol/inspector` 2.1.0 CLI, local discovery only. No production credential or owner-data call was used or retained.

| Server | Transport exercised | Tools | Read-only / non-destructive annotations |
| --- | --- | ---: | --- |
| `fleet-reader-readonly` | stdio | 3 | pass |
| `fleet-starboard-readonly` | stdio | 4 | pass |
| `fleet-high-signal-readonly` | stdio | 4 | pass |
| `fleet-calorie-readonly` | stdio | 4 | pass |
| `anime-list-by-significant-hobbies` | local Streamable HTTP | 10 | pass |
| `fleet-significant-hobbies-readonly` | stdio | 5 | pass |
| `fleet-research-papers-readonly` | stdio | 6 | pass |
| `fleet-setline-readonly` | stdio | 5 | pass |

The seven stdio servers were built from the shared helper and inspected with `tools/list`. Anime List was served by its local Worker without running a D1 migration and inspected through `/api/mcp`. Full owner-data calls remain gated on reviewed app deployment and separately issued credentials.

After the completion audit changed High Signal's track-record schema, its stdio server was inspected again: discovery exposed bounded `limit`/`offset` inputs, and a sanitized live call returned two of 400 public rows with `nextOffset: 2`. Research Papers' static degraded path was also called with a source and offset; it returned only the requested source with explicit `public-static-fallback` provenance. No record bodies or credentials were retained.

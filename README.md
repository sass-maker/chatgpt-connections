# Fleet ChatGPT connections

Seven app-specific stdio MCP servers provide bounded read-only access for ChatGPT. Anime List keeps its app-owned Streamable HTTP MCP server, so all eight applications remain independently enableable and revocable.

The application-side implementation is deployed. The Calorie and Setline
migrations are applied, and dedicated Reader, Anime List, and Calorie read
credentials are stored through Fleet's existing secret boundary. External
activation is still incomplete: Setline needs its first real owner sign-in
before a token can be issued, and the eight OpenAI tunnels and ChatGPT
connections still need their organization/workspace credentials and IDs.

## Local use

Install and verify from this directory:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm doctor -- reader
pnpm start:reader
```

Owner credentials are process-only environment variables. Never place their values in this repository, command history, test snapshots, or support output.

| Connection | Base override | Credential variable |
| --- | --- | --- |
| Reader | `READER_API_URL` | `READER_MCP_TOKEN` (`rdr_*`) |
| Starboard | `STARBOARD_API_URL` | none |
| High Signal | `HIGH_SIGNAL_API_URL` | none |
| Calorie | `CALORIE_API_URL` | `CALORIE_MCP_TOKEN` (`calorie_read_*`) |
| Significant Hobbies | `SIGNIFICANT_HOBBIES_API_URL` | none |
| Research Papers | `RESEARCH_PAPERS_API_URL` | none; defaults to local FastAPI |
| Setline | `SETLINE_API_URL` | `SETLINE_MCP_TOKEN` (`setline_read_*`) |

Remote base overrides must use HTTPS; `http://localhost` and `http://127.0.0.1` are allowed for local services. The runtime never accepts an origin, method, path, headers, request body, or SQL from a tool caller.

## Daily availability and freshness

The adapters read their upstream on every tool call; they do not maintain a second Fleet data store. “Live” therefore means the newest data currently exposed by the owning application:

| Source class | Connections | Freshness behavior |
| --- | --- | --- |
| Owner application API | Reader, Calorie, Anime List watchlists, Setline | Reads current owner-scoped application data after the owning deployment and token issuance. |
| Public application API/export | Starboard, High Signal, Anime List catalog, Significant Hobbies | Reads the currently published product surface; any product-side cache headers still apply. |
| Operator-local corpus | Research Papers search/detail/similar/hot/sleepers | Reads the current local ClickHouse corpus while ClickHouse and FastAPI are running. Hot/sleepers alone may fall back to freshness-labelled public exports. |

Secure MCP Tunnel is a persistent outbound client, not hosted storage. Dependable daily access requires all eight tunnel profiles to run on an awake, always-online designated host. That host must also keep Research Papers ClickHouse and FastAPI healthy for full corpus access. A sleeping laptop or stopped tunnel makes that connection temporarily unavailable; it never broadens access or falls back to a different private source. Run the app doctor and `tunnel-client doctor --profile <profile> --explain` after host restarts and before relying on the connection.

## Operator matrix

`<tunnel-id>` is created later in OpenAI Platform tunnel settings. Profile
creation and runtime API-key injection remain pending. Migration application,
reviewed deployments, and three of four owner credential issuances were
completed on 2026-08-11 under explicit operator approval.

| Connection | Source and command | Doctor | Tools | Privacy / degraded mode | Revocation |
| --- | --- | --- | --- | --- | --- |
| Reader | `pnpm start:reader` → owner Reader MCP routes | `pnpm doctor -- reader`; `tunnel-client doctor --profile fleet-reader --explain` | search, detail, collections | Owner library only; no PDF download/chat. Fails closed without `rdr_*`. | Revoke the dedicated Reader key and stop/remove `fleet-reader`. |
| Starboard | `pnpm start:starboard` → public APIs | `pnpm doctor -- starboard`; tunnel doctor for `fleet-starboard` | repository search/detail/preview, tool adoption | Public catalog only; no saved projects, discussions, jobs, or private repos. | Stop/remove `fleet-starboard`. |
| High Signal | `pnpm start:high-signal` → published site data | `pnpm doctor -- high-signal`; tunnel doctor for `fleet-high-signal` | signals, Daily Brief, track record | Published data only; no owner/admin/ingest/delivery routes. | Stop/remove `fleet-high-signal`. |
| Calorie | `pnpm start:calorie` → narrow owner routes | `pnpm doctor -- calorie`; tunnel doctor for `fleet-calorie` | daily nutrition, history, foods, cycles | No medications, weight records, profile identity, or writes. Fails closed without its read token. | Revoke the Calorie read token and stop/remove `fleet-calorie`. |
| Anime List | native `https://anime.significanthobbies.com/api/mcp` | app MCP/PAT tests; tunnel doctor for `fleet-anime-list` | existing 6 catalog + 4 watchlist tools | Catalog is public; watchlists require an `anime_list_*` PAT. Cookies/JWTs rejected. | Revoke the PAT and stop/remove `fleet-anime-list`. |
| Significant Hobbies | `pnpm start:significant-hobbies` → corpus/PUBLIC timelines | `pnpm doctor -- significant-hobbies`; tunnel doctor for `fleet-significant-hobbies` | hobbies, experiences, PUBLIC timelines | Daily, journals, habits, Trajectory, commitments, bucket lists, accounts, private/unlisted timelines, and device data are unaddressable. | Stop/remove `fleet-significant-hobbies`. |
| Research Papers | `pnpm start:research-papers` → local FastAPI plus approved static files | `pnpm doctor -- research-papers`; tunnel doctor for `fleet-research-papers` | search/detail/similar/hot/sleepers/reading path | No RAG/paid answer, ingest, ClickHouse access, PDF redistribution, or operator tools. Hot/sleepers alone may use labeled public-static fallback. | Stop/remove `fleet-research-papers`. |
| Setline | `pnpm start:setline` → narrow owner projections | `pnpm doctor -- setline`; tunnel doctor for `fleet-setline` | programme/templates/history/session/progress | No active execution, coaching, recommendations, sync write, import, account, or whole-state tool. | Revoke the Setline read token and stop/remove `fleet-setline`. |

Each stdio profile uses the same shape, with the appropriate start script:

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile fleet-reader \
  --tunnel-id <tunnel-id> \
  --mcp-command "pnpm --dir /Users/sarthak/Desktop/fleet/foundry/helpers/chatgpt-connections start:reader"

tunnel-client doctor --profile fleet-reader --explain
tunnel-client run --profile fleet-reader
```

Anime List uses the HTTP form:

```bash
tunnel-client init \
  --profile fleet-anime-list \
  --tunnel-id <tunnel-id> \
  --mcp-server-url https://anime.significanthobbies.com/api/mcp
```

Use the latest `tunnel-client` binary and settings-generated instructions. The official OpenAI documentation describes the tunnel as outbound-only, supports stdio or HTTP MCP servers, and requires the client to remain healthy while ChatGPT discovers and calls tools: <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>.

## Activation gate

After app reviews and checks pass, activation is deliberately ordered:

1. Calorie and Setline additive migrations and reviewed application deployments are complete.
2. Reader, Anime List, and Calorie credentials are issued through the existing secret boundary. Sign in to Setline once, then issue its dedicated credential.
3. Provide the OpenAI tunnel admin/runtime credentials plus the intended Platform organization and ChatGPT workspace IDs; create eight tunnel IDs, initialize one profile per connection, and run each doctor.
4. In ChatGPT Plugins, create one developer-mode app at a time using Tunnel as the connection.
5. Run the retained evaluations in [evaluations.md](docs/evaluations.md), capture only sanitized results, and revoke/stop any connection that violates its boundary.

The OpenAI tunnel permission and ChatGPT developer-mode permission are separate. Current official setup details are in the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Sanitized local evidence is retained in [validation-results.md](docs/validation-results.md) and [inspector-results.md](docs/inspector-results.md).

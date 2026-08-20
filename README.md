# pi-tencentdb-agent-memory

[pi](https://github.com/earendil-works/pi) extension for [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — exposes the memory gateway and the knowledge (wiki) service as native pi tools.

## Tools

| Tool | Endpoint | What it does |
|---|---|---|
| `tdai_search` | `POST /v3/atomic/search` | Semantic search over L1 memory notes |
| `tdai_memory_list` | `POST /v3/atomic/query` | List L1 notes, newest first, with pagination |
| `tdai_capture` | `POST /v3/conversation/add` | Store a note as an L0 conversation message (L1 extraction happens async) |
| `tdai_wiki_list` | `POST /v3/wiki/list` | List wikis in the knowledge service |
| `tdai_wiki_search` | `POST /v3/wiki/search` | BM25 full-text search inside one wiki |
| `tdai_wiki_pages` | `POST /v3/wiki/page/ls` | List processed pages (refs) in a wiki |
| `tdai_wiki_read` | `POST /v3/wiki/page/read` | Read up to 20 pages by ref |
| `tdai_wiki_write` | `POST /v3/wiki/page/write` | Write/update up to 20 markdown pages (auto-locks) |

## Install

Copy `extensions/tdai-memory.ts` into `~/.pi/agent/extensions/` and restart pi. No build step, no dependencies — pi loads the file directly.

## Configuration

All config is via environment variables; no defaults are baked into this repo.

| Var | Required | Description |
|---|---|---|
| `TDAI_API_KEY` | yes | Per-user key (`sk-mem-…`), sent as Bearer to the memory gateway |
| `TDAI_GATEWAY_URL` | yes | Memory gateway base URL |
| `TDAI_KNOWLEDGE_URL` | yes | Knowledge (wiki) service base URL |
| `TDAI_SERVICE_ID` | no | Defaults to `default` |
| `TDAI_TEAM_ID` / `TDAI_USER_ID` / `TDAI_AGENT_ID` | yes | Tenant identity triple, sent with every request |

## Notes

- **L0 → L1 is async.** A capture lands as an L0 conversation message; the memory pipeline extracts it into L1 notes (episodic / persona / instruction) on its own schedule, so it may not appear in `tdai_search` / `tdai_memory_list` immediately.
- **Timeouts.** 60 s per request — the first request per service id can cold-start a store.
- **Auth split.** The memory gateway requires the Bearer key; the knowledge service wiki endpoints authenticate via the team/user/agent ids only.
- The `x-tdai-service-id` request header is part of the upstream API's own branding and is not renamed.

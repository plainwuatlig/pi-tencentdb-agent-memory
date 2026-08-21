# pi-tencentdb-agent-memory

[pi](https://github.com/earendil-works/pi) extension for [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (tdai). Gives pi the same memory experience the tdai proxy gives Claude Code / Codex — but **natively, with no LLM-traffic proxy**: on-demand memory + knowledge tools, **automatic L0 conversation capture**, and **budgeted L2/L3 system-prompt injection**.

## What it does

- **8 on-demand tools** — L1 recall (`tdai_search` / `tdai_memory_list`), manual capture (`tdai_capture`), and knowledge/wiki Q&A (`tdai_wiki_list` / `search` / `pages` / `read` / `write`).
- **Automatic L0 capture** — on `session_shutdown`, the conversation is written back to tdai as L0 messages (only the delta since the last capture, chunked to ≤8192 chars, batched to ≤100 messages/post). Kill switch: `TDAI_CAPTURE=off`.
- **Budgeted prompt injection** — on `before_agent_start`, the L3 persona + selected L2 project/scenario **summaries** are injected into the system prompt within a char budget (default 16,000 ≈ 4K tokens). L2 is path + ≤200-char summary (proxy-faithful; full bodies stay on-demand). Kill switch: `TDAI_INJECT=off`.

Everything is **fail-open**: any tdai outage, timeout, or unset key degrades to “no injection / no capture” and never blocks pi.

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

Via pi (recommended):

```
pi install npm:@plainwuatlig/pi-tencentdb-agent-memory
# or from git:
pi install git:github.com/plainwuatlig/pi-tencentdb-agent-memory@v0.1.0
# try without installing:
pi -e npm:@plainwuatlig/pi-tencentdb-agent-memory
```

Team-scoped (shared, auto-installed on startup for trusted projects): add `-l` — writes `.pi/settings.json`.

## Configuration

All config is via environment variables. **Fail-fast, no defaults:** the seven “yes” vars below are required — if any is unset the extension **refuses to load** (pi shows `Failed to load extension "…/tdai-memory/index.ts": missing …` and continues without it). Set them in the shell that launches pi.

| Var | Required | Description |
|---|---|---|
| `TDAI_API_KEY` | yes | Per-user key (`sk-mem-…`), sent as Bearer to the memory gateway |
| `TDAI_GATEWAY_URL` | yes | Memory gateway base URL |
| `TDAI_KNOWLEDGE_URL` | yes | Knowledge (wiki) service base URL |
| `TDAI_SERVICE_ID` | yes | Service id (`x-tdai-service-id` header), e.g. `default` |
| `TDAI_TEAM_ID` / `TDAI_USER_ID` / `TDAI_AGENT_ID` | yes | Tenant identity triple, sent with every request |
| `TDAI_INJECT` | no | `on` (default) / `off` — L2/L3 system-prompt injection |
| `TDAI_CAPTURE` | no | `on` (default) / `off` — automatic L0 capture at shutdown |
| `TDAI_INJECT_MAX_CHARS` | no | Injection char budget (default `16000`) |
| `TDAI_SCENARIO_MAP` | no | JSON `{ "cwd-prefix": ["path", ...] }` to select L2 files; if unset, all non-directory L2 entries are injected |

## Notes

- **L0 → L1 is async.** A capture lands as an L0 conversation message; the memory pipeline extracts it into L1 notes (episodic / persona / instruction) on its own schedule, so it may not appear in `tdai_search` / `tdai_memory_list` immediately.
- **Injection is L3 + L2 summaries only.** L1 is intentionally on-demand (via the tools), not auto-injected — matching the proxy’s faithful system-prompt model.
- **Timeouts.** 60 s per request — the first request per service id can cold-start a store.
- **Auth split.** The memory gateway requires the Bearer key; the knowledge service wiki endpoints authenticate via the team/user/agent ids only.
- The `x-tdai-service-id` request header is part of the upstream API’s own branding and is not renamed.

## License

[MIT](./LICENSE)

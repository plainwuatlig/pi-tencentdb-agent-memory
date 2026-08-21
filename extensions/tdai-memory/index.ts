/**
 * TencentDB Agent Memory (tdai-memory) — pi extension
 * Upstream: https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * Exposes the memory gateway and knowledge (wiki) service as
 * native pi tools.
 *
 * Env (all required; no defaults are baked into this repo):
 *   TDAI_GATEWAY_URL    memory gateway base URL
 *   TDAI_KNOWLEDGE_URL  knowledge (wiki) service base URL
 *   TDAI_API_KEY        sk-mem-… (per-user key, Bearer for gateway)
 *   TDAI_SERVICE_ID     optional, default "default"
 *   TDAI_TEAM_ID        team-… (tenant identity, sent with every request)
 *   TDAI_USER_ID        usr-…
 *   TDAI_AGENT_ID       agt-…
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assembleMemoryBlock,
  selectScenarioPaths,
  normalizeEntries,
  splitBatches,
  DEFAULT_BUDGET_CHARS,
  type ScenarioEntry,
} from "./lib.js";

// ── Config ──────────────────────────────────────────────────────────────────
const GATEWAY_URL =
  process.env.TDAI_GATEWAY_URL ?? "";
const KNOWLEDGE_URL =
  process.env.TDAI_KNOWLEDGE_URL ?? "";
const API_KEY = process.env.TDAI_API_KEY ?? "";
const SERVICE_ID = process.env.TDAI_SERVICE_ID ?? "default";
const TEAM_ID = process.env.TDAI_TEAM_ID ?? "";
const USER_ID = process.env.TDAI_USER_ID ?? "";
const AGENT_ID = process.env.TDAI_AGENT_ID ?? "";
const TIMEOUT_MS = 60_000; // first request per serviceId can cold-start a store

// ── Behavior (L2/L3 injection + L0 capture) — both on by default; kill switches below
const INJECT_ENABLED = process.env.TDAI_INJECT !== "0";
const CAPTURE_ENABLED = process.env.TDAI_CAPTURE !== "0";
const INJECT_BUDGET_CHARS = Number(process.env.TDAI_INJECT_MAX_CHARS ?? DEFAULT_BUDGET_CHARS);

function scenarioMap(): Record<string, string[]> | undefined {
  const raw = process.env.TDAI_SCENARIO_MAP;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return undefined; // invalid JSON -> fall back to inject-all
  }
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function call(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  withAuth: boolean,
): Promise<unknown> {
  if (!baseUrl) {
    throw new Error(`tdai ${path}: base URL not set (TDAI_GATEWAY_URL / TDAI_KNOWLEDGE_URL)`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-tdai-service-id": SERVICE_ID,
    ...(withAuth && API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `tdai ${path}: request failed — ${(err as Error).message} (is the memory gateway reachable?)`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`tdai ${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const env = (await res.json()) as {
    code?: number;
    message?: string;
    request_id?: string;
    data?: unknown;
  };
  if (env.code !== undefined && env.code !== 0) {
    throw new Error(
      `tdai ${path} error ${env.code}: ${env.message} (${env.request_id})`,
    );
  }
  return env.data ?? env;
}

const idFields = () => ({
  team_id: TEAM_ID,
  user_id: USER_ID,
  agent_id: AGENT_ID,
});

function format(data: unknown): string {
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s;
}

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: format(data) }],
  details: {},
});

// ── L2/L3 injection (before_agent_start) ────────────────────────────────────
async function buildMemoryBlock(cwd: string): Promise<string> {
  if (!API_KEY) return "";
  // L3 core persona (fail-open: absence -> null).
  let core: string | null = null;
  try {
    const r = (await call(GATEWAY_URL, "/v3/core/read", idFields(), true)) as { content?: unknown };
    if (typeof r?.content === "string") core = r.content;
  } catch {
    /* no L3 */
  }

  // L2 scenario list -> select paths for this cwd -> read each.
  let entries: ScenarioEntry[] = [];
  try {
    const r = (await call(GATEWAY_URL, "/v3/scenario/ls", { ...idFields(), path_prefix: "" }, true)) as {
      entries?: ScenarioEntry[];
    };
    entries = (r?.entries ?? [])
      .filter((e): e is ScenarioEntry => typeof e?.path === "string")
      .map((e) => ({ path: e.path, summary: e.summary }));
  } catch {
    /* no L2 */
  }

  const selected = selectScenarioPaths(entries, cwd, scenarioMap());
  const scenarios = selected.map((p) => ({ path: p, summary: entries.find((e) => e.path === p)?.summary }));

  return assembleMemoryBlock({ core, scenarios, budgetChars: INJECT_BUDGET_CHARS });
}

// ── L0 capture (session_shutdown) ───────────────────────────────────────────
const CAPTURE_TYPE = "tdai-capture";

function lastCapturedEntryId(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type: string; customType?: string; data?: { lastEntryId?: string } };
    if (e.type === "custom" && e.customType === CAPTURE_TYPE) return e.data?.lastEntryId ?? null;
  }
  return null;
}

async function captureSession(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (!API_KEY) return;
  const entries = ctx.sessionManager.getEntries();
  const lastId = lastCapturedEntryId(ctx);
  const lastIdx = lastId ? entries.findIndex((e) => e.id === lastId) : -1;
  const fresh = lastIdx === -1 ? entries : entries.slice(lastIdx + 1);
  if (fresh.length === 0) return;

  const messages = normalizeEntries(fresh as Parameters<typeof normalizeEntries>[0]);
  for (const batch of splitBatches(messages)) {
    if (batch.length > 0) {
      await call(
        GATEWAY_URL,
        "/v3/conversation/add",
        { ...idFields(), session_id: ctx.sessionManager.getSessionId(), messages: batch },
        true,
      );
    }
  }

  // Record how far we've captured so a later shutdown doesn't blindly re-send.
  pi.appendEntry(CAPTURE_TYPE, { lastEntryId: fresh[fresh.length - 1].id, ts: Date.now() });
}

// ── Extension ───────────────────────────────────────────────────────────────
export default function tdaiMemoryExtension(pi: ExtensionAPI) {
  if (!API_KEY) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        "tdai-memory: TDAI_API_KEY not set — memory tools won't work",
        "warning",
      );
    });
  }

  // ── tdai_search — L1 memory semantic search ───────────────────────────────
  pi.registerTool({
    name: "tdai_search",
    label: "TDai Memory Search",
    description:
      "Semantic search over TencentDB (tdai-memory) L1 memory notes. Returns scored notes (content, type, background, timestamps).",
    promptSnippet: "Search TencentDB memory for relevant notes",
    promptGuidelines: [
      "Use tdai_search to recall memories, decisions, and context stored in TencentDB (tdai-memory).",
      "L1 note types: episodic / persona / instruction — filter with `type` if needed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 100)" })),
      type: Type.Optional(Type.String({ description: "Filter by type: episodic | persona | instruction" })),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "/v3/atomic/search",
        { ...idFields(), query: params.query, limit: params.limit ?? 5, ...(params.type ? { type: params.type } : {}) },
        true,
      );
      return result(data);
    },
  });

  // ── tdai_memory_list — list L1 notes ──────────────────────────────────────
  pi.registerTool({
    name: "tdai_memory_list",
    label: "TDai Memory List",
    description:
      "List TencentDB (tdai-memory) L1 memory notes (newest first) with pagination.",
    promptSnippet: "List TencentDB memory notes",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      offset: Type.Optional(Type.Number({ description: "Offset (default 0)" })),
      type: Type.Optional(Type.String({ description: "Filter by type: episodic | persona | instruction" })),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "/v3/atomic/query",
        { ...idFields(), limit: params.limit ?? 20, offset: params.offset ?? 0, ...(params.type ? { type: params.type } : {}) },
        true,
      );
      return result(data);
    },
  });

  // ── tdai_capture — store a note as a conversation message ─────────────────
  pi.registerTool({
    name: "tdai_capture",
    label: "TDai Capture",
    description:
      "Capture a note/thought into TencentDB (tdai-memory) as an L0 conversation message. The memory pipeline may extract it into L1 notes asynchronously.",
    promptSnippet: "Capture a note into TencentDB memory",
    promptGuidelines: [
      "Use tdai_capture to store decisions, findings, or context that should survive this session.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The note to capture" }),
      session: Type.Optional(Type.String({ description: "Session id (default: pi-<date>)" })),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "/v3/conversation/add",
        {
          ...idFields(),
          session_id: params.session ?? `pi-${new Date().toISOString().slice(0, 10)}`,
          messages: [{ role: "user", content: params.text }],
        },
        true,
      );
      return result(data);
    },
  });

  // ── tdai_wiki_list — list wikis in the knowledge service ──────────────────
  pi.registerTool({
    name: "tdai_wiki_list",
    label: "TDai Wiki List",
    description:
      "List knowledge-base wikis on the tdai-memory knowledge service. Returns wiki_id + name — needed before search/read/write.",
    promptSnippet: "List TencentDB knowledge-base wikis",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "/v3/wiki/list",
        { ...idFields(), limit: params.limit ?? 20 },
        false,
      );
      return result(data);
    },
  });

  // ── tdai_wiki_search — BM25 full-text search in a wiki ────────────────────
  pi.registerTool({
    name: "tdai_wiki_search",
    label: "TDai Wiki Search",
    description:
      "Full-text (BM25) search inside one TencentDB wiki. Requires wiki_id (from tdai_wiki_list).",
    promptSnippet: "Full-text search in a TencentDB wiki",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id (from tdai_wiki_list)" }),
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "/v3/wiki/search",
        { ...idFields(), wiki_id: params.wiki_id, query: params.query, limit: params.limit ?? 20 },
        false,
      );
      return result(data);
    },
  });

  // ── tdai_wiki_pages — list pages in a wiki ────────────────────────────────
  pi.registerTool({
    name: "tdai_wiki_pages",
    label: "TDai Wiki Pages",
    description: "List processed pages (refs) in one TencentDB wiki.",
    promptSnippet: "List pages in a TencentDB wiki",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id (from tdai_wiki_list)" }),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "/v3/wiki/page/ls",
        { ...idFields(), wiki_id: params.wiki_id },
        false,
      );
      return result(data);
    },
  });

  // ── tdai_wiki_read — read wiki pages ──────────────────────────────────────
  pi.registerTool({
    name: "tdai_wiki_read",
    label: "TDai Wiki Read",
    description:
      "Read page contents from one TencentDB wiki. refs from tdai_wiki_pages or tdai_wiki_search (max 20).",
    promptSnippet: "Read pages from a TencentDB wiki",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id (from tdai_wiki_list)" }),
      refs: Type.Array(Type.String(), { description: "Page refs to read (max 20)" }),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "/v3/wiki/page/read",
        { ...idFields(), wiki_id: params.wiki_id, refs: params.refs.slice(0, 20) },
        false,
      );
      return result(data);
    },
  });

  // ── tdai_wiki_write — write wiki pages ────────────────────────────────────
  pi.registerTool({
    name: "tdai_wiki_write",
    label: "TDai Wiki Write",
    description:
      "Write or update markdown pages in one TencentDB wiki (auto-locks pages).",
    promptSnippet: "Write pages to a TencentDB wiki",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "Wiki id (from tdai_wiki_list)" }),
      pages: Type.Array(
        Type.Object({
          ref: Type.String({ description: "Page ref/path" }),
          content: Type.String({ description: "Markdown content" }),
        }),
        { description: "Pages to write (max 20)" },
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "/v3/wiki/page/write",
        {
          ...idFields(),
          wiki_id: params.wiki_id,
          pages: params.pages.slice(0, 20),
        },
        false,
      );
      return result(data);
    },
  });

  // ── Behavior: L2/L3 injection + L0 capture (fail-open) ───────────────────
  if (INJECT_ENABLED) {
    pi.on("before_agent_start", async (event) => {
      try {
        const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
        const block = await buildMemoryBlock(cwd);
        if (!block) return;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      } catch {
        return; // fail-open: a memory outage must never block the agent
      }
    });
  }

  if (CAPTURE_ENABLED) {
    pi.on("session_shutdown", async (_event, ctx) => {
      try {
        await captureSession(ctx, pi);
      } catch {
        // fail-open: capture must never block quit/replacement
      }
    });
  }

  // ── Status on start ───────────────────────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(
      "tdai-memory",
      ctx.ui.theme.fg(
        API_KEY ? "success" : "error",
        API_KEY
          ? `tdai: ${GATEWAY_URL} (sid=${SERVICE_ID})`
          : "tdai: no TDAI_API_KEY",
      ),
    );
  });
}

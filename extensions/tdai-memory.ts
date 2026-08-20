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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

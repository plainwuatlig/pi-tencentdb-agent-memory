/**
 * TencentDB Agent Memory (tdai-memory) — pi extension
 * Upstream: https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * Exposes the memory gateway and knowledge (wiki) service as
 * native pi tools.
 *
 * Env (all required — the extension fails to load if any are missing; no defaults):
 *   TDAI_GATEWAY_URL    memory gateway base URL
 *   TDAI_KNOWLEDGE_URL  knowledge (wiki) service base URL
 *   TDAI_API_KEY        sk-mem-… (per-user key, Bearer for gateway)
 *   TDAI_SERVICE_ID     service id (x-tdai-service-id header), e.g. "default"
 *   TDAI_TEAM_ID        team-… (tenant identity, sent with every request)
 *   TDAI_USER_ID        usr-…
 *   TDAI_AGENT_ID       agt-…
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assembleMemoryBlock,
  selectScenarioPaths,
  normalizeEntries,
  splitBatches,
  missingRequiredEnv,
  isKillSwitchOff,
  atomicHitsFrom,
  atomicFingerprint,
  sameFingerprint,
  DEFAULT_BUDGET_CHARS,
  type ScenarioEntry,
  type AtomicHit,
} from "./lib.js";

// ── Config (fail-fast: every external var is required, no silent defaults) ──
// Missing required var -> throw at load -> pi reports "Failed to load extension:
// <msg>" and continues without this extension.
const missing = missingRequiredEnv(process.env);
if (missing.length > 0) {
  throw new Error(
    `tdai-memory: missing required env var(s): ${missing.join(", ")}. ` +
      "Set them (see README) and restart pi.",
  );
}
const API_KEY = process.env.TDAI_API_KEY as string;
const GATEWAY_URL = process.env.TDAI_GATEWAY_URL as string;
const KNOWLEDGE_URL = process.env.TDAI_KNOWLEDGE_URL as string;
const SERVICE_ID = process.env.TDAI_SERVICE_ID as string;
const TEAM_ID = process.env.TDAI_TEAM_ID as string;
const USER_ID = process.env.TDAI_USER_ID as string;
const AGENT_ID = process.env.TDAI_AGENT_ID as string;
const TIMEOUT_MS = 60_000; // first request per serviceId can cold-start a store
// The per-turn atomic push (below) is AUTOMATIC — the model never asked for it —
// unlike every other call in this file, which a tool call or an explicit turn start
// triggers. Reusing TIMEOUT_MS here would mean a hung (not merely refused) gateway
// adds up to 60s to EVERY ordinary turn. Tight on purpose: one vector lookup has no
// business taking longer than this, and a slow answer is worse than a skipped one.
const AUTO_ATOMIC_TIMEOUT_MS = 5_000;

// ── Behavior (L2/L3 + L1 injection + L0 capture) — all on by default; kill switches below
const INJECT_ENABLED = !isKillSwitchOff(process.env.TDAI_INJECT);
const CAPTURE_ENABLED = !isKillSwitchOff(process.env.TDAI_CAPTURE);
const INJECT_BUDGET_CHARS = Number(
  process.env.TDAI_INJECT_MAX_CHARS ?? DEFAULT_BUDGET_CHARS,
);
// Top-N atoms searched with the incoming prompt on EVERY turn — same number ADLC's
// own per-turn recall settled on (spec 18), for the same reason: fewer than a
// once-per-session push needs, since this repeats every turn rather than once per
// kernel/session life.
const ATOMIC_LIMIT = 3;

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
  urlEnvVar: string,
  path: string,
  body: Record<string, unknown>,
  withAuth: boolean,
  timeoutMs: number = TIMEOUT_MS,
): Promise<unknown> {
  if (!baseUrl) {
    throw new Error(`tdai ${path}: base URL not set (set ${urlEnvVar})`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-tdai-service-id": SERVICE_ID,
    ...(withAuth && API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(
        `tdai ${path}: timed out after ${timeoutMs / 1000}s — the first request per service id can cold-start a store; retry.`,
      );
    }
    throw new Error(
      `tdai ${path}: request failed — ${e?.message} (is the memory gateway reachable?)`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      lockHint(`tdai ${path} HTTP ${res.status}: ${text.slice(0, 500)}`),
    );
  }

  let env: {
    code?: number;
    message?: string;
    request_id?: string;
    data?: unknown;
  };
  try {
    env = (await res.json()) as typeof env;
  } catch (err) {
    throw new Error(
      `tdai ${path}: response is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (env === null || typeof env !== "object") env = {}; // literal null / scalar body
  if (env.code !== undefined && env.code !== 0) {
    throw new Error(
      lockHint(
        `tdai ${path} error ${env.code}: ${env.message} (${env.request_id})`,
      ),
    );
  }
  // "data" in env distinguishes a missing key from an explicit data:null —
  // the latter is a legitimate empty result, not the envelope.
  return "data" in env ? env.data : env;
}

// ponytail: naive "lock" substring heuristic — the knowledge API has no dedicated
// lock error code today. Replace with a code-based check if one is introduced.
function lockHint(msg: string): string {
  if (/lock/i.test(msg))
    return `${msg} — page may be locked by a concurrent write; retry`;
  return msg;
}

const idFields = () => ({
  team_id: TEAM_ID,
  user_id: USER_ID,
  agent_id: AGENT_ID,
});

// pi does not validate tool params at runtime, so enforce the documented
// bounds here too — the schema constraints alone are advisory to the model.
const clampLimit = (v: number | undefined, def: number, max = 100) =>
  Math.min(max, Math.max(1, Math.trunc(v ?? def)));
const clampOffset = (v: number | undefined) => Math.max(0, Math.trunc(v ?? 0));

function format(data: unknown): string {
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s;
}

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: format(data) }],
  details: {},
});

// Bounds the two once-per-session calls below — automatic (the model never asked
// for them), same reasoning as AUTO_ATOMIC_TIMEOUT_MS. A hung gateway must not stall
// the FIRST reply of a session by up to 120s (2 sequential calls at the old 60s
// default) — worse still now that a genuine outage retries every turn (see `ok`
// below), which without a tight bound would mean repeatedly stalling every turn.
const AUTO_SESSION_TIMEOUT_MS = 8_000;

// ── L2/L3 injection (before_agent_start, once per session) ──────────────────
/**
 * `ok` distinguishes "genuinely nothing to inject" from "could not reach tdai" —
 * found by review: `buildMemoryBlock` used to swallow both cases identically
 * (empty core, empty scenarios), so the caller had no way to tell a real outage
 * from an empty-but-healthy memory, and latched `sessionOpened = true` either way.
 * One transient hiccup at the exact moment of a session's FIRST prompt meant no
 * persona for the rest of that session's life, silently. `ok` is true unless BOTH
 * calls threw — mirrors ADLC's own spec-15 recall push ("not (persona.ok or
 * scenarios.ok)" — a total outage, not a partial one, is what actually blocks).
 */
async function buildMemoryBlock(cwd: string): Promise<{ block: string; ok: boolean }> {
  // L3 core persona (fail-open: absence -> null).
  let core: string | null = null;
  let coreOk = false;
  try {
    const r = (await call(
      GATEWAY_URL,
      "TDAI_GATEWAY_URL",
      "/v3/core/read",
      idFields(),
      true,
      AUTO_SESSION_TIMEOUT_MS,
    )) as { content?: unknown };
    if (typeof r?.content === "string") core = r.content;
    coreOk = true;
  } catch {
    /* no L3 */
  }

  // L2 scenario list -> select paths for this cwd -> read each.
  let entries: ScenarioEntry[] = [];
  let scenariosOk = false;
  try {
    const r = (await call(
      GATEWAY_URL,
      "TDAI_GATEWAY_URL",
      "/v3/scenario/ls",
      { ...idFields(), path_prefix: "" },
      true,
      AUTO_SESSION_TIMEOUT_MS,
    )) as {
      entries?: ScenarioEntry[];
    };
    entries = (r?.entries ?? [])
      .filter((e): e is ScenarioEntry => typeof e?.path === "string")
      .map((e) => ({ path: e.path, summary: e.summary }));
    scenariosOk = true;
  } catch {
    /* no L2 */
  }

  const selected = selectScenarioPaths(entries, cwd, scenarioMap());
  const scenarios = selected.map((p) => ({
    path: p,
    summary: entries.find((e) => e.path === p)?.summary,
  }));

  return {
    block: assembleMemoryBlock({ core, scenarios, budgetChars: INJECT_BUDGET_CHARS }),
    ok: coreOk || scenariosOk,
  };
}

// ── L1 per-turn injection (before_agent_start, every turn) ──────────────────
// Module-level, on purpose: one Node process = one pi session's worth of "kernel
// life" (same distinction ADLC's own coordinators.py draws) — a fresh process
// naturally starts with no fingerprint to dedupe against and no full-block sent yet,
// no explicit reset needed. `session_start` below resets both anyway for the
// mid-process case (/resume, /fork, /new): a different conversation must not be
// judged against the PREVIOUS one's last atoms, and deserves its own full push.
let sessionOpened = false;
let lastAtomicFingerprint: string[] | null = null;

// Caps the query sent to /v3/atomic/search — found by review: `event.prompt` handed
// straight through was UNBOUNDED, so a 200,000-char prompt posted 200,000 chars every
// turn. Every other boundary in this file is capped (MAX_MSG_CHARS 8192, refs/pages
// limits); a search query needs far less than that to be useful, and a very long
// query is not obviously BETTER for a vector/BM25 backend than a capped one.
const ATOMIC_QUERY_MAX_CHARS = 2000;

/**
 * The proxy-mimic per-turn push (mirrors ADLC spec 18): search THIS TURN's own
 * incoming prompt text against L1 atoms, top `ATOMIC_LIMIT`, rendered via the same
 * `assembleMemoryBlock` the full L2/L3 push uses. Landing in a visible session
 * MESSAGE (see the `before_agent_start` handler below), not spliced into the system
 * prompt — the whole point of this refactor: every injection is a reviewable row in
 * the transcript, not invisible context the model silently receives.
 *
 * Skipped (returns "") when this turn's hits are IDENTICAL to the previous turn's —
 * a topic that persists across turns must not silt the transcript with the same
 * three atoms every single time. An outage is NEVER deduped against a prior outage
 * (`lastAtomicFingerprint` is reset to null on failure) — unlike ADLC's own harness,
 * this returns the failure VISIBLY inline rather than a separate marker constant,
 * since this file has no equivalent of `tdai.unavailable_marker` to reuse.
 */
async function buildTurnAtomicBlock(query: string): Promise<string> {
  const trimmed = query.trim().slice(0, ATOMIC_QUERY_MAX_CHARS);
  if (!trimmed) return "";
  let hits: AtomicHit[];
  try {
    const data = await call(
      GATEWAY_URL,
      "TDAI_GATEWAY_URL",
      "/v3/atomic/search",
      { ...idFields(), query: trimmed, limit: ATOMIC_LIMIT },
      true,
      AUTO_ATOMIC_TIMEOUT_MS,
    );
    hits = atomicHitsFrom(data);
  } catch (err) {
    lastAtomicFingerprint = null; // an outage is never "the same as last turn"
    return `<tdai-memory-unavailable>\n${(err as Error).message}\n</tdai-memory-unavailable>`;
  }
  const fp = atomicFingerprint(hits);
  if (sameFingerprint(lastAtomicFingerprint, fp)) return "";
  lastAtomicFingerprint = fp;
  if (fp.length === 0) return "";
  // budgetChars explicit: found by review — omitting it here silently fell back to
  // lib.ts's own DEFAULT_BUDGET_CHARS (16000) instead of honoring TDAI_INJECT_MAX_CHARS,
  // harmless only by coincidence (3 hits × 200 chars is nowhere near either budget).
  return assembleMemoryBlock({
    core: null,
    scenarios: [],
    atomicHits: hits,
    budgetChars: INJECT_BUDGET_CHARS,
  });
}

// ── L0 capture (session_shutdown) ───────────────────────────────────────────
const CAPTURE_TYPE = "tdai-capture";

function lastCapturedEntryId(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as {
      type: string;
      customType?: string;
      data?: { lastEntryId?: string };
    };
    if (e.type === "custom" && e.customType === CAPTURE_TYPE)
      return e.data?.lastEntryId ?? null;
  }
  return null;
}

async function captureSession(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const entries = ctx.sessionManager.getEntries();
  const lastId = lastCapturedEntryId(ctx);
  const lastIdx = lastId ? entries.findIndex((e) => e.id === lastId) : -1;
  const fresh = lastIdx === -1 ? entries : entries.slice(lastIdx + 1);
  if (fresh.length === 0) return;

  const messages = normalizeEntries(
    fresh as Parameters<typeof normalizeEntries>[0],
  );
  for (const batch of splitBatches(messages)) {
    if (batch.length > 0) {
      await call(
        GATEWAY_URL,
        "TDAI_GATEWAY_URL",
        "/v3/conversation/add",
        {
          ...idFields(),
          session_id: ctx.sessionManager.getSessionId(),
          messages: batch,
        },
        true,
      );
    }
  }

  // Record how far we've captured so a later shutdown doesn't blindly re-send.
  pi.appendEntry(CAPTURE_TYPE, {
    lastEntryId: fresh[fresh.length - 1].id,
    ts: Date.now(),
  });
}

// ── Extension ───────────────────────────────────────────────────────────────
export default function tdaiMemoryExtension(pi: ExtensionAPI) {
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
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Max results (default 5, max 100)",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description: "Filter by type: episodic | persona | instruction",
        }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "TDAI_GATEWAY_URL",
        "/v3/atomic/search",
        {
          ...idFields(),
          query: params.query,
          limit: clampLimit(params.limit, 5),
          ...(params.type ? { type: params.type } : {}),
        },
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
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Max results (default 20, max 100)",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Offset (default 0)" }),
      ),
      type: Type.Optional(
        Type.String({
          description: "Filter by type: episodic | persona | instruction",
        }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "TDAI_GATEWAY_URL",
        "/v3/atomic/query",
        {
          ...idFields(),
          limit: clampLimit(params.limit, 20),
          offset: clampOffset(params.offset),
          ...(params.type ? { type: params.type } : {}),
        },
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
      session: Type.Optional(
        Type.String({ description: "Session id (default: pi-<date>)" }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        GATEWAY_URL,
        "TDAI_GATEWAY_URL",
        "/v3/conversation/add",
        {
          ...idFields(),
          // || (not ??): an explicit empty session also falls back to the default.
          // toLocaleDateString("en-CA") = YYYY-MM-DD in the caller's local time.
          session_id:
            params.session || `pi-${new Date().toLocaleDateString("en-CA")}`,
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
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Max results (default 20, max 100)",
        }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "TDAI_KNOWLEDGE_URL",
        "/v3/wiki/list",
        { ...idFields(), limit: clampLimit(params.limit, 20) },
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
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Max results (default 20, max 100)",
        }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "TDAI_KNOWLEDGE_URL",
        "/v3/wiki/search",
        {
          ...idFields(),
          wiki_id: params.wiki_id,
          query: params.query,
          limit: clampLimit(params.limit, 20),
        },
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
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Max results (default 20, max 100)",
        }),
      ),
    }),
    async execute(_id, params) {
      const data = await call(
        KNOWLEDGE_URL,
        "TDAI_KNOWLEDGE_URL",
        "/v3/wiki/page/ls",
        {
          ...idFields(),
          wiki_id: params.wiki_id,
          limit: clampLimit(params.limit, 20),
        },
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
      refs: Type.Array(Type.String(), {
        description: "Page refs to read (max 20)",
      }),
    }),
    async execute(_id, params) {
      if (params.refs.length > 20) {
        throw new Error(
          `tdai_wiki_read: ${params.refs.length} refs given, max is 20 — split into multiple calls`,
        );
      }
      const data = await call(
        KNOWLEDGE_URL,
        "TDAI_KNOWLEDGE_URL",
        "/v3/wiki/page/read",
        { ...idFields(), wiki_id: params.wiki_id, refs: params.refs },
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
      "Write or update markdown pages in one TencentDB wiki. Pages are locked during concurrent writes; a locked page fails with a lock error — retry.",
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
      if (params.pages.length > 20) {
        throw new Error(
          `tdai_wiki_write: ${params.pages.length} pages given, max is 20 — split into multiple calls`,
        );
      }
      const data = await call(
        KNOWLEDGE_URL,
        "TDAI_KNOWLEDGE_URL",
        "/v3/wiki/page/write",
        {
          ...idFields(),
          wiki_id: params.wiki_id,
          pages: params.pages,
        },
        false,
      );
      return result(data);
    },
  });

  // ── Behavior: L2/L3 (once per session) + L1 (every turn) injection, visible ─
  if (INJECT_ENABLED) {
    // A fresh session — /new, /resume, /fork, or a brand-new process — starts its
    // own full push and must not be judged against the PREVIOUS session's last
    // atoms. `before_agent_start` always fires after this on the first turn (see
    // the framework's own lifecycle: session_start precedes every prompt), so
    // resetting here is enough; no ordering race with the read below.
    pi.on("session_start", () => {
      sessionOpened = false;
      lastAtomicFingerprint = null;
    });

    // Compaction can summarize away the injected message just like any other
    // conversation entry (session_compact treats custom messages as an ordinary cut
    // point) — found by review: the OLD design (spliced into systemPrompt, rebuilt
    // fresh every turn) was structurally immune to this; moving delivery to a
    // visible message reopened it. Re-arming here means the NEXT turn after a
    // compaction gets the full persona back, rather than it being gone for the rest
    // of the process life.
    pi.on("session_compact", () => {
      sessionOpened = false;
    });

    pi.on("before_agent_start", async (event) => {
      const parts: string[] = [];

      // The full L2/L3 push, ONCE per session — not every turn. Found in this
      // refactor, not merely inherited: once injection becomes a VISIBLE message
      // (below) rather than an invisible system-prompt splice, repeating a mostly-
      // static persona+scenario block on every single turn would be transcript
      // clutter, not context. Each half stays independently fail-open, same as
      // buildMemoryBlock's own internal per-call try/catch.
      //
      // The latch (`sessionOpened = true`) is set ONLY when `ok` — found by review:
      // setting it unconditionally meant a single transient hiccup at the exact
      // moment of a session's FIRST prompt silently lost the persona for that
      // session's entire life, because `buildMemoryBlock` is internally fail-open
      // and never actually throws, so the outer catch never had a chance to leave
      // `sessionOpened` false for a retry. Left false, the very next turn retries.
      if (!sessionOpened) {
        try {
          const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
          const { block, ok } = await buildMemoryBlock(cwd);
          if (block) parts.push(block);
          if (ok) sessionOpened = true;
        } catch {
          /* fail-open: a memory outage must never block the agent; sessionOpened
             stays false so the next turn retries */
        }
      }

      // The per-turn L1 push — every turn, this turn's own incoming text.
      try {
        const turnBlock = await buildTurnAtomicBlock(event.prompt ?? "");
        if (turnBlock) parts.push(turnBlock);
      } catch {
        /* fail-open: buildTurnAtomicBlock itself is fail-open internally, but
           nothing outside this file guarantees it always will be */
      }

      if (parts.length === 0) return;
      return {
        message: {
          customType: "tdai-memory-inject",
          content: parts.join("\n\n"),
          display: true,
        },
      };
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
  // All required env vars are guaranteed at load (fail-fast above), so success
  // here is accurate — there is no partially-configured state to report.
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(
      "tdai-memory",
      ctx.ui.theme.fg("success", `tdai: ${GATEWAY_URL} (sid=${SERVICE_ID})`),
    );
  });
}

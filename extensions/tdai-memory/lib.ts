// extensions/tdai-memory/lib.ts
// Pure, dependency-free logic for the tdai-memory pi extension:
//   - L0 capture: normalize a pi session into user/assistant messages
//   - L2/L3 injection: select scenarios + assemble the budgeted prompt block
// No pi imports, no network — unit-testable in isolation.

export const MAX_MSG_CHARS = 8192; // tdai conversation/add: content 1..8192 JS chars
export const MAX_MSGS_PER_POST = 100; // tdai conversation/add: 1..100 messages per POST
export const DEFAULT_BUDGET_CHARS = 16000; // ~4K tokens of injected memory

export interface ScenarioEntry {
  path: string;
  summary?: string;
}
export interface ScenarioContent {
  path: string;
  content: string;
}
export interface MemoryBlockInput {
  core?: string | null;
  scenarios: ScenarioContent[];
  budgetChars?: number;
}
export interface L0Message {
  role: "user" | "assistant";
  content: string;
}

/** Minimal view of a pi session entry — only the fields the normalizer reads. */
export interface SessionEntryLike {
  type: string;
  id: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
  };
}

/** A content part of a pi message (text / toolCall / ...). Only fields we read. */
interface ContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** Split a string into pieces of 1..max chars (UTF-16 units), order preserved, no loss. Empty -> []. */
export function chunkContent(s: string, max: number = MAX_MSG_CHARS): string[] {
  if (s.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/** Split a flat message list into batches of at most maxPerBatch, order preserved. Empty -> []. */
export function splitBatches(messages: L0Message[], maxPerBatch: number = MAX_MSGS_PER_POST): L0Message[][] {
  if (messages.length === 0) return [];
  const out: L0Message[][] = [];
  for (let i = 0; i < messages.length; i += maxPerBatch) out.push(messages.slice(i, i + maxPerBatch));
  return out;
}

/**
 * Choose which L2 scenario paths to inject for a cwd.
 * If `map` has a key that is a prefix of `cwd`, return the longest match's paths.
 * Otherwise return every non-directory entry (inject-all).
 */
export function selectScenarioPaths(
  entries: ScenarioEntry[],
  cwd: string,
  map?: Record<string, string[]>,
): string[] {
  if (map) {
    let bestKey: string | null = null;
    for (const key of Object.keys(map)) {
      if (cwd.startsWith(key) && (bestKey === null || key.length > bestKey.length)) bestKey = key;
    }
    if (bestKey !== null) return map[bestKey];
  }
  return entries.filter((e) => !e.path.endsWith("/")).map((e) => e.path);
}

/** Join the text parts of a message's content (string or array-of-parts). */
function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as ContentPart).text === "string" ? (p as ContentPart).text : ""))
      .join("\n");
  }
  return "";
}

/** Drop a trailing scene-navigation block (a line starting with "## 🗺️"). */
function stripSceneNav(s: string): string {
  const lines = s.split("\n");
  const cut = lines.findIndex((l) => l.trimStart().startsWith("## 🗺️"));
  return cut === -1 ? s : lines.slice(0, cut).join("\n").trimEnd();
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * Assemble the <tdai-memory> prompt block from L3 core + selected L2 scenarios,
 * within budgetChars. L3 first, then scenarios in order, skipping any that don't fit.
 * Returns "" when there is nothing to inject.
 */
export function assembleMemoryBlock(input: MemoryBlockInput): string {
  const { core, scenarios } = input;
  const budget = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const header = "<tdai-memory>\n";
  const footer = "\n</tdai-memory>";

  const coreText = stripSceneNav((core ?? "").trim());
  const scenes = scenarios.filter((s) => (s.content ?? "").trim().length > 0);
  if (!coreText && scenes.length === 0) return "";

  // Core section (truncated to fit on its own if the persona alone exceeds the budget).
  let coreSection: string | null = null;
  if (coreText) {
    const coreLine = "### Core\n";
    const allow = Math.max(0, budget - header.length - footer.length - coreLine.length);
    coreSection = `### Core\n${allow >= coreText.length ? coreText : coreText.slice(0, allow)}`;
  }

  const render = (chosen: string[]) => {
    const parts = [...(coreSection ? [coreSection] : []), ...chosen];
    return header + parts.join("\n\n") + footer;
  };

  // Add scenario sections in order, skipping any that would exceed the budget.
  const chosen: string[] = [];
  for (const s of scenes) {
    const section = `### Project: ${s.path}\n${(s.content ?? "").trim()}`;
    if (render([...chosen, section]).length <= budget) chosen.push(section);
  }

  return render(chosen);
}

/**
 * Normalize pi session entries into tdai L0 messages (user/assistant only).
 * thinking dropped; toolCall -> assistant text; toolResult -> user text;
 * long content chunked to <= MAX_MSG_CHARS; empty messages dropped; order preserved.
 */
export function normalizeEntries(entries: SessionEntryLike[]): L0Message[] {
  const out: L0Message[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    for (const piece of chunkContent(text)) out.push({ role, content: piece });
  };

  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;

    if (m.role === "user") {
      const t = partText(m.content).trim();
      if (t) push("user", t);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(m.content)) {
        for (const raw of m.content as ContentPart[]) {
          if (!raw || typeof raw !== "object") continue;
          if (raw.type === "text" && typeof raw.text === "string") {
            parts.push(raw.text);
          } else if (raw.type === "toolCall") {
            parts.push(`[tool_call id=${raw.id ?? ""} name=${raw.name ?? ""} ${safeJson(raw.arguments ?? {})}]`);
          }
          // "thinking" and anything else: intentionally dropped
        }
      } else if (typeof m.content === "string") {
        parts.push(m.content);
      }
      const t = parts.filter((x) => x.trim()).join("\n").trim();
      if (t) push("assistant", t);
    } else if (m.role === "toolResult") {
      const t = partText(m.content).trim();
      if (t) push("user", `[tool_result name=${m.toolName ?? ""}] ${t}`);
    }
  }

  return out;
}

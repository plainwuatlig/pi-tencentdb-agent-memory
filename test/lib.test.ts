import { test, expect } from "bun:test";
import {
  chunkContent,
  splitBatches,
  selectScenarioPaths,
  assembleMemoryBlock,
  normalizeEntries,
  MAX_MSG_CHARS,
  MAX_MSGS_PER_POST,
  type L0Message,
  type SessionEntryLike,
} from "../extensions/tdai-memory/lib.js";

// ── chunkContent ─────────────────────────────────────────────────────────────
test("chunkContent: short string -> single unchanged chunk", () => {
  expect(chunkContent("hello")).toEqual(["hello"]);
});

test("chunkContent: each chunk within max, order + no data loss", () => {
  const s = "a".repeat(25) + "b".repeat(25); // 50 chars, max 30
  const chunks = chunkContent(s, 30);
  for (const c of chunks) expect(c.length).toBeGreaterThanOrEqual(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  expect(chunks.join("")).toBe(s);
});

test("chunkContent: default max is 8192", () => {
  expect(MAX_MSG_CHARS).toBe(8192);
  const s = "x".repeat(8192 * 2 + 5);
  const chunks = chunkContent(s);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8192);
  expect(chunks.join("")).toBe(s);
});

test("chunkContent: empty string -> no chunks", () => {
  expect(chunkContent("")).toEqual([]);
});

// ── splitBatches ─────────────────────────────────────────────────────────────
test("splitBatches: <= maxPerBatch per batch, order + no loss", () => {
  const msgs: L0Message[] = Array.from({ length: 101 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: String(i),
  }));
  const batches = splitBatches(msgs, 100);
  expect(batches).toHaveLength(2);
  for (const b of batches) expect(b.length).toBeLessThanOrEqual(100);
  expect(batches.flat()).toEqual(msgs);
});

test("splitBatches: default max is 100", () => {
  expect(MAX_MSGS_PER_POST).toBe(100);
});

test("splitBatches: empty -> no batches", () => {
  expect(splitBatches([])).toEqual([]);
});

// ── selectScenarioPaths ──────────────────────────────────────────────────────
const ENTRIES = [
  { path: "工作/", summary: "dir" },
  { path: "工作/pi.md" },
  { path: "工作/交付物.md" },
  { path: "misc.md" },
];

test("selectScenarioPaths: no map -> inject all non-directory entries", () => {
  expect(selectScenarioPaths(ENTRIES, "/anywhere")).toEqual([
    "工作/pi.md",
    "工作/交付物.md",
    "misc.md",
  ]);
});

test("selectScenarioPaths: map prefix match -> mapped paths", () => {
  const map = { "/Users/plainwu/Working/ai/plain": ["工作/pi.md"] };
  expect(selectScenarioPaths(ENTRIES, "/Users/plainwu/Working/ai/plain/x", map)).toEqual(["工作/pi.md"]);
});

test("selectScenarioPaths: longest cwd prefix wins", () => {
  const map = {
    "/Users/plainwu/Working": ["a.md"],
    "/Users/plainwu/Working/ai/plain": ["b.md"],
  };
  expect(selectScenarioPaths(ENTRIES, "/Users/plainwu/Working/ai/plain", map)).toEqual(["b.md"]);
});

test("selectScenarioPaths: map present but no prefix match -> inject all", () => {
  const map = { "/elsewhere": ["nope.md"] };
  expect(selectScenarioPaths(ENTRIES, "/here", map)).toEqual(["工作/pi.md", "工作/交付物.md", "misc.md"]);
});

// ── assembleMemoryBlock ──────────────────────────────────────────────────────
test("assembleMemoryBlock: nothing to inject -> empty string", () => {
  expect(assembleMemoryBlock({ core: null, scenarios: [] })).toBe("");
  expect(assembleMemoryBlock({ core: "", scenarios: [{ path: "p.md", content: "" }] })).toBe("");
});

test("assembleMemoryBlock: core + scenario, within budget, correct shape", () => {
  const block = assembleMemoryBlock({
    core: "I am the core persona.",
    scenarios: [{ path: "工作/pi.md", content: "project facts" }],
  });
  expect(block).toContain("I am the core persona.");
  expect(block).toContain("project facts");
  expect(block).toContain("工作/pi.md");
  expect(block.length).toBeLessThanOrEqual(16000);
  expect(block.trimStart().startsWith("<tdai-memory>")).toBe(true);
});

test("assembleMemoryBlock: core before scenarios in output order", () => {
  const block = assembleMemoryBlock({
    core: "CORE_MARKER",
    scenarios: [{ path: "s.md", content: "SCENE_MARKER" }],
  });
  expect(block.indexOf("CORE_MARKER")).toBeLessThan(block.indexOf("SCENE_MARKER"));
});

test("assembleMemoryBlock: strips a trailing '## 🗺️' scene-nav block from core", () => {
  const block = assembleMemoryBlock({ core: "persona line\n## 🗺️\n- nav item", scenarios: [] });
  expect(block).toContain("persona line");
  expect(block).not.toContain("nav item");
});

test("assembleMemoryBlock: drops scenarios that exceed the budget", () => {
  const big = "z".repeat(5000);
  const block = assembleMemoryBlock({
    core: "core",
    scenarios: [
      { path: "fits.md", content: "small" },
      { path: "big.md", content: big },
    ],
    budgetChars: 2000,
  });
  expect(block.length).toBeLessThanOrEqual(2000);
  expect(block).toContain("core");
  expect(block).toContain("small"); // fits before the big one
  expect(block).not.toContain("zzzzzz");
});

// ── normalizeEntries ─────────────────────────────────────────────────────────
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}): SessionEntryLike => ({
  type: "message",
  id: Math.random().toString(36).slice(2),
  message: { role, content, ...extra },
});

test("normalizeEntries: user text -> one user message", () => {
  const out = normalizeEntries([msg("user", [{ type: "text", text: "hi" }])]);
  expect(out).toEqual([{ role: "user", content: "hi" }]);
});

test("normalizeEntries: assistant text + thinking dropped + toolCall -> assistant text", () => {
  const out = normalizeEntries([
    msg("assistant", [
      { type: "text", text: "let me check" },
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ]),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].role).toBe("assistant");
  expect(out[0].content).toContain("let me check");
  expect(out[0].content).toContain("bash");
  expect(out[0].content).not.toContain("hidden reasoning");
});

test("normalizeEntries: toolResult -> user message with name + text", () => {
  const out = normalizeEntries([
    msg("toolResult", [{ type: "text", text: "file listing" }], { toolName: "read" }),
  ]);
  expect(out).toEqual([{ role: "user", content: "[tool_result name=read] file listing" }]);
});

test("normalizeEntries: ignores non-message entries", () => {
  const out = normalizeEntries([
    { type: "compaction", id: "x" },
    { type: "custom_message", id: "y" },
    msg("user", [{ type: "text", text: "kept" }]),
  ]);
  expect(out).toEqual([{ role: "user", content: "kept" }]);
});

test("normalizeEntries: long content is chunked to <= 8192 chars, no loss", () => {
  const big = "q".repeat(20000);
  const out = normalizeEntries([msg("assistant", [{ type: "text", text: big }])]);
  expect(out.length).toBeGreaterThan(1);
  for (const m of out) expect(m.content.length).toBeLessThanOrEqual(MAX_MSG_CHARS);
  expect(out.map((m) => m.content).join("")).toBe(big);
});

test("normalizeEntries: empty content is dropped", () => {
  const out = normalizeEntries([msg("assistant", [{ type: "thinking", thinking: "only thinking" }])]);
  expect(out).toEqual([]);
});

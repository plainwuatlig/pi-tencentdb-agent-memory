import { test, expect } from "bun:test";

// Configure the extension BEFORE importing it (it reads config at module load).
process.env.TDAI_GATEWAY_URL = "http://tdai.test";
process.env.TDAI_API_KEY = "fake-key";
process.env.TDAI_TEAM_ID = "team-test";
process.env.TDAI_USER_ID = "usr-test";
process.env.TDAI_AGENT_ID = "agt-test";
process.env.TDAI_INJECT = "1";
process.env.TDAI_CAPTURE = "1";

// Mock fetch — route by URL suffix, capture request bodies.
const calls: { url: string; body: Record<string, unknown> }[] = [];
const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url: String(url), body });
  const u = String(url);
  if (u.endsWith("/v3/core/read")) return json(200, { code: 0, data: { content: "TEST CORE PERSONA" } });
  if (u.endsWith("/v3/scenario/ls"))
    return json(200, { code: 0, data: { entries: [{ path: "proj.md", summary: "proj summary" }], total: 1 } });
  if (u.endsWith("/v3/conversation/add")) return json(200, { code: 0, data: { ok: true } });
  return json(404, { code: 1, message: "not found" });
}) as typeof fetch;

const { default: extension } = await import("../extensions/tdai-memory/index.js");

function makePi() {
  const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
  const appended: Array<{ type: string; data?: unknown }> = [];
  const pi = {
    on: (name: string, fn: (...a: unknown[]) => unknown) => {
      (handlers[name] ||= []).push(fn);
    },
    registerTool: () => {},
    appendEntry: (type: string, data?: unknown) => {
      appended.push({ type, data });
    },
  };
  return { pi, handlers, appended };
}

test("before_agent_start injects core + scenario into the system prompt", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  const h = handlers.before_agent_start[0];
  const res = (await h({ systemPrompt: "BASE PROMPT", systemPromptOptions: { cwd: "/test/cwd" } }, {})) as {
    systemPrompt: string;
  };
  expect(res.systemPrompt).toContain("BASE PROMPT");
  expect(res.systemPrompt).toContain("TEST CORE PERSONA");
  expect(res.systemPrompt).toContain("proj.md");
  expect(res.systemPrompt).toContain("proj summary");
});

test("session_shutdown captures the session (normalized) and records the marker", async () => {
  const { pi, handlers, appended } = makePi();
  extension(pi);
  const entries = [
    { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    {
      type: "message",
      id: "e2",
      message: { role: "assistant", content: [{ type: "text", text: "hi there" }, { type: "thinking", thinking: "secret" }] },
    },
  ];
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => "sess-1" } };
  await handlers.session_shutdown[0]({}, ctx);

  const add = calls.find((c) => c.url.endsWith("/v3/conversation/add"));
  expect(add).toBeTruthy();
  expect(add.body.messages).toEqual([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  expect(add.body.session_id).toBe("sess-1");
  expect(appended[0].type).toBe("tdai-capture");
  expect((appended[0].data as { lastEntryId: string }).lastEntryId).toBe("e2");
});

test("session_shutdown is a no-op when nothing new since the last capture", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  const before = calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length;
  const entries = [
    { type: "custom", id: "m1", customType: "tdai-capture", data: { lastEntryId: "e2" } },
    { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ];
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => "sess-1" } };
  await handlers.session_shutdown[0]({}, ctx);
  const after = calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length;
  expect(after).toBe(before); // dedupe: no re-send
});

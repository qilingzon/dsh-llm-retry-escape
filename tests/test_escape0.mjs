// test_escape0.mjs — ESCAPE_AFTER=0 时完全回到纯无限重试（31 次连败仍安排重试）
// 运行前必须设置环境变量 DSH_RETRY_ESCAPE_AFTER=0（由启动器注入）
import assert from "node:assert/strict";

const plugin = await import(new URL("../index.js", import.meta.url).href);
const listeners = {}; const logs = [];
plugin.apply({
  on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
  effect() {},
  logger: { warn: (...a) => logs.push(a.map(String).join(" ")), debug: () => {}, info: () => {} },
});
const onRequestError = listeners["agent/request-error"][0];

const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const key = JSON.stringify(["always", 1, 1, 0]);
const events = [];
for (let r = 1; r <= 31; r++) events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey: key, retry: r, retryId: "rid" } });
const agent = { session: { header: { id: "s1", origin: "root" }, events, append: (type, data) => events.push({ type, data }) } };

const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
assert.deepEqual(result, { kind: "retry" }, "ESCAPE_AFTER=0 -> never escapes");
assert.ok(!logs.some((l) => l.includes("escape valve")), "no escape log");
console.log("RESULT pass=1 fail=0 (ESCAPE_AFTER=0 pure infinite)");

// v0.3.1：测试结果入洞察账本（设置页「反卡死历史」面板可见）
try {
  plugin._internal.appendInsight({
    source: "test-suite",
    session: "tests/test_escape0.mjs",
    workspace: process.cwd(),
    phenomenon: "test",
    detail: "test_escape0 v0.3.1: ESCAPE_AFTER=0 纯无限重试通过（31 连败仍安排重试）",
    resolved: "全部通过",
    lesson: "逃生阀可关——DSH_RETRY_ESCAPE_AFTER=0 回到纯无限重试语义",
  });
} catch { /* 账本失败不影响退出码 */ }

process.exit(0);

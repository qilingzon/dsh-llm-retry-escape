// test_plugin.mjs — dsh-llm-retry-escape 单元测试（mock ctx，无真实 Host）v0.3.1
// 适配 v0.3.x B 语义：只有"调用过工具且零落盘"的轮才记伪进度（纯聊天轮不惩罚）。
// 测试结果以 phenomenon=test 写入洞察账本——设置页「反卡死历史」面板可见。
// 运行：DSH Desktop.exe（ELECTRON_RUN_AS_NODE=1）tests/test_plugin.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 哨兵必须在插件加载前启用（模块读 env 决定监听目录；此处用全局覆盖模式）
const watchDir = await fsp.mkdtemp(join(tmpdir(), "rl-watch-"));
process.env.DSH_PROGRESS_WATCH_DIR = watchDir;

const plugin = await import(new URL("../index.js", import.meta.url).href);

let pass = 0, fail = 0; const fails = [];
function ok(name, fn) { try { fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); } }
async function okA(name, fn) { try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); } }

function makeCtx() {
  const listeners = {}; const logs = [];
  const ctx = {
    on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
    effect(fn, label) { void fn; void label; },
    logger: { warn: (...a) => logs.push(a.map(String).join(" ")), debug: () => {}, info: () => {} },
  };
  return { ctx, listeners, logs };
}

function makeAgent(events, id = "s1", origin = "root") {
  return {
    session: {
      header: { id, origin },
      events,
      append: (type, data) => { events.push({ type, data }); },
    },
  };
}

const alwaysKey = (p) => JSON.stringify(["always", p.initialDelayMs, p.maxDelayMs, p.jitterRatio]);
function prefill(events, policy, n) {
  const key = alwaysKey(policy);
  for (let r = 1; r <= n; r++) events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey: key, retry: r, retryId: "rid" } });
}

const tinyPolicy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const bigPolicy  = { mode: "always", initialDelayMs: 1000, maxDelayMs: 600000, jitterRatio: 0 };
const normPolicy = { mode: "normal", maxRetries: 2, retryableCodes: ["TIMEOUT"], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };

const { ctx, listeners, logs } = makeCtx();
plugin.apply(ctx);
const onRequestError = listeners["agent/request-error"][0];
const onPreStep = listeners["agent/pre-step"]?.[0];
const onTurnStopping = listeners["agent/turn-stopping"]?.[0];
const onToolExecute = listeners["tools/post-execute"]?.[0];

const enterNext = async () => ({ kind: "enter", messages: [] });
// 一个"在干活"的轮：pre-step + 一次工具调用（v0.3.x 语义：没有它不算伪进度嫌疑）
async function workTurn(agent, turn) {
  await onPreStep({ agent, turn }, enterNext);
  await onToolExecute({ agent }, null, async () => "ok");
}

ok("exports", () => {
  assert.equal(plugin.name, "dsh-llm-retry-escape");
  assert.ok(plugin.inject.includes("agents"));
  assert.equal(typeof plugin.apply, "function");
});
ok("hooks registered", () => {
  assert.equal(typeof onRequestError, "function");
  assert.equal(typeof onPreStep, "function");
  assert.equal(typeof onTurnStopping, "function");
  assert.equal(typeof onToolExecute, "function", "v0.3.x tools/post-execute hook");
});

// A1 逃生阀：30 次连败 → 终止本轮，且 next() 恰好只被调一次
await okA("escape at 30 consecutive failures", async () => {
  const events = []; const agent = makeAgent(events);
  prefill(events, tinyPolicy, 30);
  let nextCalls = 0;
  const next = async () => { nextCalls++; return "TERMINAL"; };
  const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: tinyPolicy, signal: new AbortController().signal }, next);
  assert.equal(result, "TERMINAL");
  assert.equal(nextCalls, 1, "next() must be called exactly once (no double-next)");
  assert.ok(logs.some((l) => l.includes("escape valve")), "warn log with escape valve");
});

// A1 边界：29 次连败 → 仍安排第 30 次重试（durable 事件成对）
await okA("retry scheduled at 29", async () => {
  const events = []; const agent = makeAgent(events);
  prefill(events, tinyPolicy, 29);
  const before = events.length;
  const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: tinyPolicy, signal: new AbortController().signal }, async () => "TERMINAL");
  assert.deepEqual(result, { kind: "retry" });
  assert.equal(events.length - before, 2, "llm/retry + llm/retry-started appended");
  assert.equal(events[events.length - 1].type, "llm/retry-started");
  assert.equal(events[events.length - 1].data.retry, 30);
});

// A2 探测封顶（v0.3.1 = 5s）：maxDelayMs=600000 但实际等待 ≤5s（第 6 次重试，指数 32s → 5s）
await okA("delay capped at 5s", async () => {
  const events = []; const agent = makeAgent(events);
  prefill(events, bigPolicy, 5);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 150);
  await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: bigPolicy, signal: ac.signal }, async () => "TERMINAL");
  clearTimeout(t);
  const last = [...events].reverse().find((e) => e.type === "llm/retry");
  assert.equal(last.data.retry, 6);
  assert.equal(last.data.delayMs, 5000, "escalated cap = 5000 exactly");
});

// A2 尊重上游 Retry-After（≤ 封顶时原样采用）
await okA("providerRetryAfterMs respected when <= cap", async () => {
  const events = []; const agent = makeAgent(events);
  prefill(events, bigPolicy, 5);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 150);
  await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "RATE_LIMIT", providerRetryAfterMs: 5000 }, retryPolicy: bigPolicy, signal: ac.signal }, async () => "TERMINAL");
  clearTimeout(t);
  const last = [...events].reverse().find((e) => e.type === "llm/retry");
  assert.equal(last.data.delayMs, 5000);
});

// A2 上游 Retry-After 超封顶 → 压到 5s（不硬敲也不傻等）
await okA("providerRetryAfterMs capped when > 5s", async () => {
  const events = []; const agent = makeAgent(events);
  prefill(events, bigPolicy, 5);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 150);
  await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "RATE_LIMIT", providerRetryAfterMs: 45000 }, retryPolicy: bigPolicy, signal: ac.signal }, async () => "TERMINAL");
  clearTimeout(t);
  const last = [...events].reverse().find((e) => e.type === "llm/retry");
  assert.equal(last.data.delayMs, 5000);
});

// normal 透传：maxRetries 耗尽 → 终止，不再追加重试事件
await okA("normal mode exhausted -> terminal", async () => {
  const events = []; const agent = makeAgent(events);
  const key = JSON.stringify(["normal", 2, ["TIMEOUT"], 1, 1, 0]);
  for (let r = 1; r <= 2; r++) events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey: key, retry: r, retryId: "r2" } });
  const before = events.length;
  const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: normPolicy, signal: new AbortController().signal }, async () => "TERMINAL");
  assert.equal(result, "TERMINAL");
  assert.equal(events.length, before, "no retry events appended");
});

// normal 透传：不可重试 code → 立即终止
await okA("normal mode non-retryable -> terminal", async () => {
  const events = []; const agent = makeAgent(events);
  const before = events.length;
  const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "INVALID_CREDENTIAL" }, retryPolicy: normPolicy, signal: new AbortController().signal }, async () => "TERMINAL");
  assert.equal(result, "TERMINAL");
  assert.equal(events.length, before);
});

// B 哨兵（v0.3.x）：干活但零落盘的轮 → streak=1 → 下一轮注入 progress-warning
await okA("sentinel: tool-activity zero-disk turn injects warning next turn", async () => {
  const agent = makeAgent([], "sA");
  await workTurn(agent, 1);                              // 干活但零落盘
  await onTurnStopping({ agent });                       // 零变化 + sawTools → streak 1
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 1);
  assert.equal(d2.messages[0].source.form, "progress-warning");
  assert.equal(d2.messages[0].source.plugin, "dsh-llm-retry-escape");
});

// B 哨兵（v0.3.x）：纯聊天轮（无工具活动）零落盘 → 不惩罚，不注入
await okA("sentinel: pure chat turn (no tools) is not punished", async () => {
  const agent = makeAgent([], "sE");
  await onPreStep({ agent, turn: 1 }, enterNext);        // 无工具活动
  await onTurnStopping({ agent });                       // 零变化但没干活 → streak 0
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 0, "chat turn must not count as pseudo-progress");
});

// B 哨兵（v0.3.x）：连续 2 个干活轮零落盘 → 警告升级为"必须换方法"
await okA("sentinel: streak 2 escalates wording", async () => {
  const agent = makeAgent([], "sB");
  await workTurn(agent, 1);
  await onTurnStopping({ agent });                       // streak 1
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 1);
  await workTurn(agent, 2);                              // 又一轮干活（pre-step 在 workTurn 内）
  await onTurnStopping({ agent });                       // streak 2
  const d3 = await onPreStep({ agent, turn: 3 }, enterNext);
  assert.equal(d3.messages.length, 1);
  assert.ok(d3.messages[0].content[0].text.includes("连续 2 轮"), "escalated text");
});

// B 哨兵：干活轮出现真实落盘 → streak 清零，不再警告
await okA("sentinel: real disk change resets streak", async () => {
  const agent = makeAgent([], "sC");
  await workTurn(agent, 1);
  await onTurnStopping({ agent });                       // 干活零落盘 → streak 1
  await fsp.writeFile(join(watchDir, "artifact.txt"), "real progress");
  await onTurnStopping({ agent });                       // 有变化 → streak 0（+解除记录）
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 0, "no warning after real progress");
});

// B 哨兵：subagent 会话完全跳过
await okA("sentinel: subagent skipped", async () => {
  const agent = makeAgent([], "sD", "subagent");
  await workTurn(agent, 1);
  await onTurnStopping({ agent });
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 0);
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));

// v0.3.1：测试结果入洞察账本（设置页「反卡死历史」面板可见）
try {
  plugin._internal.appendInsight({
    source: "test-suite",
    session: "tests/test_plugin.mjs",
    workspace: process.cwd(),
    phenomenon: "test",
    detail: `test_plugin v0.3.1: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}`,
    resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
    lesson: "测试结果入账本——账本-路由-面板链路自检（用户要求历史可见）",
  });
} catch { /* 账本失败不影响测试退出码 */ }

process.exit(fail ? 1 : 0);

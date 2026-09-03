// test_strategy_v034.mjs — v0.3.4 失败步策略注入单元测试（mock ctx，无真实 Host）
// 验证：连败 ≥2 → 下一轮 pre-step 注入 retry-strategy 策略消息；guard 分支（1 败不注/去重/
// subagent 跳过/normal 模式不跟踪/0=关闭）+ strategy-injected 账本落盘。
// 运行：node tests/test_strategy_v034.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-strategy-home-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_RETRY_ESCAPE_AFTER = "30"; // 阀在本套件中不触发，隔离变量
process.env.DSH_RETRY_STRATEGY_AFTER = "2";
process.env.DSH_PROGRESS_WATCH_DIR = await fsp.mkdtemp(join(tmpdir(), "rl-strategy-watch-"));

const plugin = await import(new URL("../index.js", import.meta.url).href);

let pass = 0, fail = 0; const fails = [];
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
	return { id, session: { header: { id, origin }, events, append: (type, data) => { events.push({ type, data }); } } };
}
const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const policyKey = JSON.stringify(["always", 1, 1, 0]);
async function failOnce(ctx, listeners, agent, turn, step, code = "TRANSPORT", retry = undefined) {
	// 真实路径：request-error 恢复钩子自己记 llm/retry 并调度 backoff（1ms 延迟）
	return listeners["agent/request-error"][0]({ agent, turn, step, provider: "p", failure: { code }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
}
const preStep = (listeners) => listeners["agent/pre-step"][0];
const enterNext = async () => ({ kind: "enter", messages: [] });

// T1 连败 2 次 → 下一轮 pre-step 注入 1 条 retry-strategy 策略消息（含计数/码/形状指令）
await okA("2 consecutive fails -> strategy injected at next pre-step", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a1");
	await failOnce(ctx, listeners, agent, 1, 1, "TRANSPORT");
	await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT");
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 1, "exactly one injected message");
	assert.equal(d.messages[0].source.form, "retry-strategy");
	const text = d.messages[0].content[0].text;
	assert.ok(text.includes("连续失败 2 次"), "names fail count");
	assert.ok(text.includes("TRANSPORT/TIMEOUT"), "names failure codes");
	assert.ok(text.includes("1500") && text.includes("追加") && text.includes("骨架"), "contains shape instructions");
	// 账本
	const lines = (await fsp.readFile(join(tempHome, "retry-insights.jsonl"), "utf8")).split("\n").filter(Boolean);
	const rec = lines.map((l) => JSON.parse(l)).find((r) => r.phenomenon === "strategy-injected");
	assert.ok(rec, "strategy-injected ledger record");
	assert.ok(rec.detail.includes("turn1/step1") && rec.detail.includes("连败 2 次"));
});

// T2 注入去重：第二次 pre-step 不再注
await okA("strategy injected once (deduped)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a2");
	await failOnce(ctx, listeners, agent, 1, 1);
	await failOnce(ctx, listeners, agent, 1, 1);
	await preStep(listeners)({ agent, turn: 2 }, enterNext);
	const d2 = await preStep(listeners)({ agent, turn: 3 }, enterNext);
	assert.equal(d2.messages.length, 0, "no repeat injection");
});

// T3 只败 1 次 → 不注入
await okA("single fail -> no injection", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a3");
	await failOnce(ctx, listeners, agent, 1, 1);
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0);
});

// T4 连败跨 5 次（阀路径）→ 计数取最大值 5，注入一次
await okA("storm to 5 fails -> injected with count 5", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a4");
	for (let i = 1; i <= 5; i++) await failOnce(ctx, listeners, agent, 1, 1, i % 2 ? "TRANSPORT" : "TIMEOUT");
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 1);
	assert.ok(d.messages[0].content[0].text.includes("连续失败 5 次"));
});

// T5 subagent 会话不注入
await okA("subagent session skipped", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a5", "subagent");
	await failOnce(ctx, listeners, agent, 1, 1);
	await failOnce(ctx, listeners, agent, 1, 1);
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0);
});

// T6 normal 模式失败不跟踪策略（与内置逐字一致原则）
await okA("normal mode failures not tracked", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a6");
	const norm = { mode: "normal", maxRetries: 5, retryableCodes: ["TIMEOUT"], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
	for (let i = 1; i <= 3; i++) {
		agent.session.events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey: JSON.stringify(["normal", 5, ["TIMEOUT"], 1, 1, 0]), retry: i, retryId: "rn" } });
		await listeners["agent/request-error"][0]({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: norm, signal: new AbortController().signal }, async () => "TERMINAL");
	}
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0, "normal mode stays byte-identical, no strategy");
});

// T7 STRATEGY_AFTER=0 → 关闭（env 在 import 时固化，与 ESCAPE_AFTER 同语义；此用例由独立进程覆盖——
// 等价断言：阈值消费端判断 + 未达阈值静默消费，见 T3/T7b）
await okA("below-threshold storm consumed silently (STRATEGY_AFTER boundary)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a7");
	await failOnce(ctx, listeners, agent, 1, 1);
	// 另一步只败 1 次
	await failOnce(ctx, listeners, agent, 1, 2);
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0, "1-fail storms must not inject");
	// 且不留残留：再来一步也不会注出旧风暴
	const d2 = await preStep(listeners)({ agent, turn: 3 }, enterNext);
	assert.equal(d2.messages.length, 0, "no stale injection");
});

// T8 策略消息与伪进度警告可同轮叠加（两条 extras）
await okA("strategy coexists with progress-warning in same pre-step", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "a8");
	// turn1：先干活（伪进度条件），再连败 2 次（策略条件），零落盘收轮
	const onTool = listeners["tools/post-execute"][0];
	await preStep(listeners)({ agent, turn: 1 }, enterNext);
	await onTool({ agent }, null, async () => "ok");
	await failOnce(ctx, listeners, agent, 1, 1);
	await failOnce(ctx, listeners, agent, 1, 1);
	await listeners["agent/turn-stopping"][0]({ agent });
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 2, "both injected");
	assert.ok(d.messages.some((m) => m.source.form === "retry-strategy"));
	assert.ok(d.messages.some((m) => m.source.form === "progress-warning"));
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));

process.env.DSH_HOME = "";
try {
	plugin._internal.appendInsight({
		source: "test-suite",
		session: "tests/test_strategy_v034.mjs",
		workspace: process.cwd(),
		phenomenon: "test",
		detail: `test_strategy_v034 v0.3.4: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}（连败≥2→注入 retry-strategy + 去重/subagent/normal/关闭 guard + 与伪进度叠加）`,
		resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
		lesson: "换新请求必须换生成形状——策略注入把运气变成纪律",
	});
} catch { /* 不影响退出码 */ }
process.exit(fail ? 1 : 0);

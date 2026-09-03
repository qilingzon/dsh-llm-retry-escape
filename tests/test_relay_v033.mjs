// test_relay_v033.mjs — v0.3.3 阀后自动接力单元测试（mock ctx.goals，无真实 Host）
// 验证：阀收尾 → 轮空闲 → goals.resume 重新武装（含全部 guard 分支）；resume 抛错不打断主循环。
// 运行：node tests/test_relay_v033.mjs（或 DSH Desktop.exe ELECTRON_RUN_AS_NODE=1）
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 账本写到临时 DSH_HOME（避免污染真实账本）；阈值固定 5（部署值，确定性）
const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-relay-home-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_RETRY_ESCAPE_AFTER = "5";
process.env.DSH_PROGRESS_WATCH_DIR = await fsp.mkdtemp(join(tmpdir(), "rl-relay-watch-"));

const plugin = await import(new URL("../index.js", import.meta.url).href);

let pass = 0, fail = 0; const fails = [];
async function okA(name, fn) { try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); } }

function makeCtx(goalView) {
	const listeners = {}; const logs = []; const resumes = [];
	const ctx = {
		on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
		effect(fn, label) { void fn; void label; },
		logger: { warn: (...a) => logs.push(a.map(String).join(" ")), debug: () => {}, info: () => {} },
		goals: {
			get: () => goalView,
			resume: (agent, ref) => {
				if (goalView?.__throw) throw new Error(goalView.__throw);
				resumes.push(ref);
				return { ...goalView, activation: "armed" };
			},
		},
	};
	return { ctx, listeners, logs, resumes };
}
function makeAgent(events, id = "s1") {
	return { id, session: { header: { id, origin: "root" }, events, append: (type, data) => { events.push({ type, data }); } } };
}
const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const policyKey = JSON.stringify(["always", 1, 1, 0]);
function prefill(events, n) {
	for (let r = 1; r <= n; r++) events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey, retry: r, retryId: "rid" } });
}
async function fireValve(ctx, listeners, agent) {
	// prefill 5 次连败后第 6 次失败 → 阀触发（previousRetry=5 >= 5）
	const next = async () => "TERMINAL";
	return ctx && listeners["agent/request-error"][0]({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, next);
}
const statusHandler = (listeners) => listeners["agent/status"].find((h) => h.length === 1 || true); // 唯一的 agent/status 监听器

const activeDisarmed = { id: "goal-x", revision: 7, phase: "active", activation: "disarmed", roundsStarted: 2, maxGoalRounds: 6 };

// T1 阀收尾 → idle → resume 以 {id, revision} 调用一次；再次 idle 不重复
await okA("valve turn + idle rearms goal exactly once", async () => {
	const { ctx, listeners, resumes } = makeCtx({ ...activeDisarmed });
	plugin.apply(ctx);
	const agent = makeAgent([], "a1");
	prefill(agent.session.events, 5);
	const result = await fireValve(ctx, listeners, agent);
	assert.equal(result, "TERMINAL", "valve returns downstream decision");
	await listeners["agent/status"][0]({ agent, status: "running" });
	assert.equal(resumes.length, 0, "no rearm while running");
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 1, "rearmed once on idle");
	assert.deepEqual(resumes[0], { id: "goal-x", revision: 7 });
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 1, "flag consumed — no double rearm");
});

// T2 goal 已 armed → 不 resume（628 行 already-armed 保护）
await okA("no rearm when goal already armed", async () => {
	const { ctx, listeners, resumes } = makeCtx({ ...activeDisarmed, activation: "armed" });
	plugin.apply(ctx);
	const agent = makeAgent([], "a2");
	prefill(agent.session.events, 5);
	await fireValve(ctx, listeners, agent);
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 0, "armed goal must not be resumed");
});

// T3 无 goal → 不 resume、不抛
await okA("no rearm when no goal exists", async () => {
	const { ctx, listeners, resumes } = makeCtx(undefined);
	plugin.apply(ctx);
	const agent = makeAgent([], "a3");
	prefill(agent.session.events, 5);
	await fireValve(ctx, listeners, agent);
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 0);
});

// T4 未发生阀收尾的空闲 → 不 resume
await okA("no rearm without valve fire", async () => {
	const { ctx, listeners, resumes } = makeCtx({ ...activeDisarmed });
	plugin.apply(ctx);
	const agent = makeAgent([], "a4");
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 0, "idle without valve must not touch goal");
});

// T5 resume 抛错（如轮预算耗尽）→ 不打断、记 warn 日志
await okA("resume throw is contained and logged", async () => {
	const { ctx, listeners, logs, resumes } = makeCtx({ ...activeDisarmed, __throw: "exhausted 6 goal rounds" });
	plugin.apply(ctx);
	const agent = makeAgent([], "a5");
	prefill(agent.session.events, 5);
	await fireValve(ctx, listeners, agent);
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 0);
	assert.ok(logs.some((l) => l.includes("relay re-arm failed")), "warn log recorded");
});

// T6 goals 服务缺失（旧宿主）→ 优雅跳过
await okA("missing goals service is tolerated", async () => {
	const listeners = {}; const logs = [];
	const ctx = {
		on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
		effect() {}, logger: { warn: (...a) => logs.push(String(a)), debug() {}, info() {} },
	};
	plugin.apply(ctx);
	const agent = makeAgent([], "a6");
	prefill(agent.session.events, 5);
	await fireValve(ctx, listeners, agent);
	await listeners["agent/status"][0]({ agent, status: "idle" });
});

// T7 阈值边界：4 次连败 + 第 5 次失败 → 仍安排第 5 次重试（不触发阀、不武装）
await okA("4 fails still schedules retry #5 (no valve, no rearm)", async () => {
	const { ctx, listeners, resumes } = makeCtx({ ...activeDisarmed });
	plugin.apply(ctx);
	const agent = makeAgent([], "a7");
	prefill(agent.session.events, 4);
	const events = agent.session.events;
	const result = await listeners["agent/request-error"][0]({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	assert.deepEqual(result, { kind: "retry" });
	assert.equal(events[events.length - 1].type, "llm/retry-started");
	assert.equal(events[events.length - 1].data.retry, 5);
	await listeners["agent/status"][0]({ agent, status: "idle" });
	assert.equal(resumes.length, 0, "no valve → no rearm");
});

// T8 relay-rearmed 账本记录真实落盘（临时 DSH_HOME）
await okA("relay-rearmed insight written to ledger", async () => {
	const { ctx, listeners } = makeCtx({ ...activeDisarmed });
	plugin.apply(ctx);
	const agent = makeAgent([], "a8");
	prefill(agent.session.events, 5);
	await fireValve(ctx, listeners, agent);
	await listeners["agent/status"][0]({ agent, status: "idle" });
	const lines = (await fsp.readFile(join(tempHome, "retry-insights.jsonl"), "utf8")).split("\n").filter(Boolean);
	const records = lines.map((l) => JSON.parse(l));
	const relay = records.find((r) => r.phenomenon === "relay-rearmed");
	assert.ok(relay, "relay-rearmed record exists");
	assert.ok(relay.detail.includes("goal-x"), "detail names the goal");
	assert.ok(records.some((r) => r.phenomenon === "deadloop" && r.detail.includes("连败 5 次")), "deadloop record precedes relay");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));

// 汇总入真实账本（设置页可见）：动态 insightsPath 支持运行期切 env
process.env.DSH_HOME = "";
try {
	plugin._internal.appendInsight({
		source: "test-suite",
		session: "tests/test_relay_v033.mjs",
		workspace: process.cwd(),
		phenomenon: "test",
		detail: `test_relay_v033 v0.3.3: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}（阀收尾→idle→goals.resume 重新武装 + guard 分支 + 账本落盘）`,
		resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
		lesson: "止损的终点是接力——阀后自动重武装让无人值守闭环成立",
	});
} catch { /* 不影响退出码 */ }
process.exit(fail ? 1 : 0);

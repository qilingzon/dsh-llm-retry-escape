// test_v036_ladder.mjs — v0.3.6 策略注入升级阶梯单元测试（mock ctx，无真实 Host）
// 验证：L1 自适应注入 → 风暴仍在 → L2「拆任务」升级（strategy-escalated 入账）→ 封顶 L2
//       → 风暴痊愈复位 L1；DSH_RETRY_STRATEGY_MAX_LEVEL=0 关闭整个注入（子进程覆盖 env 固化）。
// 运行：node tests/test_v036_ladder.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-ladder-home-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_RETRY_ESCAPE_AFTER = "30";
process.env.DSH_RETRY_STRATEGY_AFTER = "2";
process.env.DSH_PROGRESS_WATCH_DIR = await fsp.mkdtemp(join(tmpdir(), "rl-ladder-watch-"));

const pluginUrl = new URL("../dsh-llm-retry-escape/index.js", import.meta.url).href;
const plugin = await import(pluginUrl);

let pass = 0, fail = 0; const fails = [];
async function okA(name, fn) { try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); } }

function makeCtx() {
	const listeners = {};
	const ctx = {
		on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
		effect() {},
		logger: { warn: () => {}, debug: () => {}, info: () => {} },
	};
	return { ctx, listeners };
}
function makeAgent(events, id = "s1", origin = "root") {
	return { id, session: { header: { id, origin }, events, append: (type, data) => { events.push({ type, data }); } } };
}
const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
async function failOnce(ctx, listeners, agent, turn, step, code = "TRANSPORT") {
	return listeners["agent/request-error"][0]({ agent, turn, step, provider: "p", failure: { code }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
}
const preStep = (listeners) => listeners["agent/pre-step"][0];
const enterNext = async () => ({ kind: "enter", messages: [] });
async function ledger() {
	const lines = (await fsp.readFile(join(tempHome, "retry-insights.jsonl"), "utf8")).split("\n").filter(Boolean);
	return lines.map((l) => JSON.parse(l));
}
// T1 首次风暴 → L1 自适应话术（无升级标记，summary=连败策略注入，账本 strategy-injected）
await okA("first storm -> L1 adaptive injection (no escalation)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "l1");
	await failOnce(ctx, listeners, agent, 1, 1, "TRANSPORT");
	await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT");
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 1);
	const m = d.messages[0];
	assert.equal(m.source.form, "retry-strategy");
	assert.equal(m.source.summary, "连败策略注入");
	assert.ok(!m.content[0].text.includes("升级"), "L1 text must not carry escalation marker");
	const rec = (await ledger()).filter((r) => r.phenomenon === "strategy-injected").pop();
	assert.ok(rec && rec.detail.includes("turn1/step1") && rec.detail.includes("连败 2 次"));
});

// T2 注入后风暴仍在 → L2「拆任务」升级（summary=连败策略升级，账本 strategy-escalated）
await okA("storm persists after L1 -> L2 task-split escalation", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "l2");
	await failOnce(ctx, listeners, agent, 1, 1, "TRANSPORT");
	await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT");
	const d1 = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d1.messages.length, 1);
	assert.ok(!d1.messages[0].content[0].text.includes("升级"), "round1 must be L1");
	for (let i = 0; i < 3; i++) await failOnce(ctx, listeners, agent, 2, 1, i % 2 ? "TIMEOUT" : "TRANSPORT");
	const d2 = await preStep(listeners)({ agent, turn: 3 }, enterNext);
	assert.equal(d2.messages.length, 1);
	const text = d2.messages[0].content[0].text;
	assert.ok(text.includes("[retry-strategy·升级]"), "escalation marker");
	assert.ok(text.includes("拆") && text.includes("progress.md") && text.includes("blocked"), "task-split directives");
	assert.ok(text.includes("连败 3 次"));
	assert.equal(d2.messages[0].source.summary, "连败策略升级(L2)");
	const esc = (await ledger()).filter((r) => r.phenomenon === "strategy-escalated").pop();
	assert.ok(esc, "strategy-escalated ledger record");
	assert.ok(esc.detail.includes("turn2/step1") && esc.detail.includes("仍连败 3 次") && esc.detail.includes("L2"));
});

// T3 连续风暴封顶 L2（不出 L3）；痊愈一轮后复位，新风暴回到 L1
await okA("escalation caps at L2 and resets after a clean round", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "cap");
	await failOnce(ctx, listeners, agent, 1, 1);
	await failOnce(ctx, listeners, agent, 1, 1);
	await preStep(listeners)({ agent, turn: 2 }, enterNext);            // L1
	await failOnce(ctx, listeners, agent, 2, 1);
	await failOnce(ctx, listeners, agent, 2, 1);
	const d3 = await preStep(listeners)({ agent, turn: 3 }, enterNext); // L2
	assert.ok(d3.messages[0].content[0].text.includes("升级"), "round2 escalates");
	await failOnce(ctx, listeners, agent, 3, 1);
	await failOnce(ctx, listeners, agent, 3, 1);
	const d4 = await preStep(listeners)({ agent, turn: 4 }, enterNext); // 封顶仍 L2
	assert.equal(d4.messages.length, 1);
	assert.ok(d4.messages[0].content[0].text.includes("升级"), "still escalated at cap");
	assert.ok(!d4.messages[0].content[0].text.includes("L3"), "no L3 invention");
	await preStep(listeners)({ agent, turn: 5 }, enterNext);            // 痊愈轮 → 阶梯复位
	await failOnce(ctx, listeners, agent, 5, 1);
	await failOnce(ctx, listeners, agent, 5, 1);
	const d6 = await preStep(listeners)({ agent, turn: 6 }, enterNext); // 新风暴回 L1
	assert.equal(d6.messages.length, 1);
	assert.ok(!d6.messages[0].content[0].text.includes("升级"), "fresh storm back to L1 after reset");
});

// T4 MAX_LEVEL=0 → 关闭整个策略注入（env 在 import 时固化，用独立子进程覆盖）
await okA("MAX_LEVEL=0 disables strategy injection entirely (subprocess)", async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const home2 = await fsp.mkdtemp(join(tmpdir(), "rl-ladder-off-"));
	const watch2 = await fsp.mkdtemp(join(tmpdir(), "rl-ladder-offw-"));
	const script = [
		'const assert = (await import("node:assert/strict")).default;',
		`const plugin = await import(${JSON.stringify(pluginUrl)});`,
		'const listeners = {};',
		'const ctx = { on(e, h) { (listeners[e] ||= []).push(h); }, effect() {}, logger: { warn() {}, debug() {}, info() {} } };',
		'plugin.apply(ctx);',
		'const agent = { id: "off1", session: { header: { id: "off1", origin: "root" }, events: [], append() {} } };',
		'const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };',
		'const h = listeners["agent/request-error"][0];',
		'for (let i = 0; i < 4; i++) await h({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");',
		'const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, async () => ({ kind: "enter", messages: [] }));',
		'assert.equal(d.messages.length, 0, "MAX_LEVEL=0 must silence injection");',
		'console.log("SUBOK");',
	].join("\n");
	const r = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, DSH_HOME: home2, DSH_PROGRESS_WATCH_DIR: watch2, DSH_RETRY_ESCAPE_AFTER: "30", DSH_RETRY_STRATEGY_AFTER: "2", DSH_RETRY_STRATEGY_MAX_LEVEL: "0" },
		timeout: 20000,
	});
	assert.ok(r.stdout.includes("SUBOK"), "subprocess asserts passed");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));
process.env.DSH_HOME = "";
try {
	plugin._internal.appendInsight({
		source: "test-suite",
		session: "tests/test_v036_ladder.mjs",
		workspace: process.cwd(),
		phenomenon: "test",
		detail: `test_v036_ladder v0.3.6: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}（L1→L2 拆任务升级/封顶/痊愈复位/MAX_LEVEL=0 关闭）`,
		resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
		lesson: "同一粒度反复失败=粒度病——升级阶梯把「换说法」变成「换粒度」",
	});
} catch { /* 不影响退出码 */ }
process.exit(fail ? 1 : 0);

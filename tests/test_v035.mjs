// test_v035.mjs — v0.3.5 三项改进单元测试（mock ctx，无真实 Host）
// ① config-disease 自动诊断（同码连败 + 间隔≈常数，DSH_CONFIG_DISEASE_MIN_MS=0 加速）
// ② 策略注入按失败码自适应（限流/网关/掐流三种话术）
// ③ B 哨兵只认写入类工具（纯读取轮不再误报伪进度）
// 运行：node tests/test_v035.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-v035-home-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_RETRY_ESCAPE_AFTER = "30";
process.env.DSH_RETRY_STRATEGY_AFTER = "2";
process.env.DSH_CONFIG_DISEASE_MIN_MS = "0";   // 测试加速：去掉 20s 间隔下限
process.env.DSH_PROGRESS_WATCH_DIR = await fsp.mkdtemp(join(tmpdir(), "rl-v035-watch-"));

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
const enterNext = async () => ({ kind: "enter", messages: [] });

async function failOnce(ctx, listeners, agent, turn, step, code, message) {
	return listeners["agent/request-error"][0]({ agent, turn, step, provider: "p", failure: { code, message }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
}
async function ledgerRecords() {
	const t = await fsp.readFile(join(tempHome, "retry-insights.jsonl"), "utf8");
	return t.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── ① config-disease ──
await okA("config-disease: 4x Request timed out. -> diagnosed with advice", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "cd1");
	// 25ms 可控间隔：让 gaps 的中位数与离散度稳定（真实场景 ~90s，此处等比缩小）
	const gap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	gap(); await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "Request timed out.");
	gap(); await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "Request timed out.");
	gap(); await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "Request timed out.");
	gap(); await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "Request timed out.");
	const recs = await ledgerRecords();
	const cd = recs.filter((r) => r.phenomenon === "config-disease" && r.session === "cd1");
	assert.equal(cd.length, 1, "exactly one config-disease record");
	assert.ok(cd[0].detail.includes("Request timed out."), "names the death mode");
	assert.ok(cd[0].detail.includes("timeoutMs"), "names the config knob");
	assert.ok(cd[0].resolved.includes("settings.yaml"), "points at settings.yaml");
	// 同一步继续失败不重复报
	await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "Request timed out.");
	const recs2 = await ledgerRecords();
	assert.equal(recs2.filter((r) => r.phenomenon === "config-disease" && r.session === "cd1").length, 1, "deduped per step");
});

await okA("config-disease: non-timeout message -> no diagnosis", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "cd2");
	for (let i = 1; i <= 4; i++) await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "pi-ai stream idle timeout after 120000ms");
	const recs = await ledgerRecords();
	assert.equal(recs.filter((r) => r.phenomenon === "config-disease" && r.session === "cd2").length, 0, "stream idle is not config disease");
});

// ── ② 自适应策略 ──
await okA("adaptive strategy: RATE_LIMIT-only -> pacing advice (not shape)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "as1");
	await failOnce(ctx, listeners, agent, 1, 1, "RATE_LIMIT");
	await failOnce(ctx, listeners, agent, 1, 1, "RATE_LIMIT");
	const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, enterNext);
	const text = d.messages[0].content[0].text;
	assert.ok(text.includes("限流"), "pacing advice for rate limit");
	assert.ok(!text.includes("输出体积太大"), "must NOT misdiagnose rate limit as output size");
});
await okA("adaptive strategy: SERVER-only -> gateway advice", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "as2");
	await failOnce(ctx, listeners, agent, 1, 1, "SERVER", "502 Bad Gateway");
	await failOnce(ctx, listeners, agent, 1, 1, "SERVER", "504 Gateway Time-out");
	const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, enterNext);
	const text = d.messages[0].content[0].text;
	assert.ok(text.includes("网关"), "gateway advice");
	assert.ok(!text.includes("输出体积太大"));
});
await okA("adaptive strategy: TRANSPORT/TIMEOUT -> shape advice (unchanged)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "as3");
	await failOnce(ctx, listeners, agent, 1, 1, "TRANSPORT", "terminated");
	await failOnce(ctx, listeners, agent, 1, 1, "TIMEOUT", "pi-ai stream idle timeout after 120000ms");
	const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, enterNext);
	const text = d.messages[0].content[0].text;
	assert.ok(text.includes("1500") && text.includes("追加"), "shape advice for stream kills");
});

// ── ③ 哨兵写入类过滤 ──
await okA("sentinel: read-only tools do not count as work", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "rw1");
	const onTool = listeners["tools/post-execute"][0];
	await listeners["agent/pre-step"][0]({ agent, turn: 1 }, enterNext);
	await onTool({ agent, name: "read" }, null, async () => "ok");
	await onTool({ agent, name: "grep" }, null, async () => "ok");
	await onTool({ agent, name: "web_search" }, null, async () => "ok");
	await listeners["agent/turn-stopping"][0]({ agent });
	const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0, "pure read turn is not pseudo-progress");
});
await okA("sentinel: write tools still count (and bash keeps counting)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "rw2");
	const onTool = listeners["tools/post-execute"][0];
	await listeners["agent/pre-step"][0]({ agent, turn: 1 }, enterNext);
	await onTool({ agent, name: "write" }, null, async () => "ok");
	await onTool({ agent, name: "pwsh" }, null, async () => "ok");
	await listeners["agent/turn-stopping"][0]({ agent });
	const d = await listeners["agent/pre-step"][0]({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 1, "write/bash turns still flagged when zero disk change");
	assert.equal(d.messages[0].source.form, "progress-warning");
});

// ── 回归：策略注入主路径不回归 ──
await okA("regression: 5-fail storm still ends via valve (ESCAPE_AFTER=30 here)", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "rg1");
	const events = agent.session.events;
	const result = await listeners["agent/request-error"][0]({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT", message: "terminated" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	assert.deepEqual(result, { kind: "retry" });
	assert.equal(events[events.length - 1].type, "llm/retry-started");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));

process.env.DSH_HOME = "";
try {
	plugin._internal.appendInsight({
		source: "test-suite",
		session: "tests/test_v035.mjs",
		workspace: process.cwd(),
		phenomenon: "test",
		detail: `test_v035 v0.3.5: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}（config-disease 诊断 / 自适应策略三话术 / 哨兵写入类过滤）`,
		resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
		lesson: "先分诊死法再对症——限流不是体积病，超时上限是配置病",
	});
} catch { /* 不影响退出码 */ }
process.exit(fail ? 1 : 0);

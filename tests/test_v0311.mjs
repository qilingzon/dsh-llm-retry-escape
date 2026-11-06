// test_v0311.mjs — v0.3.11 定点修复（误报/质量/效率/token 成本）
// 覆盖：写意图判定 / 指纹截断降级 / 已解决风暴不注入 / 注入预算 / 致命码不重试 /
//       风暴时长闸 / provider 冷却 / 默认策略结构判定 / 注入前缀与文案。
// 运行：node tests/test_v0311.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-v0311-home-"));
const watchDir = await fsp.mkdtemp(join(tmpdir(), "rl-v0311-watch-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_PROGRESS_WATCH_DIR = watchDir;
process.env.DSH_RETRY_ESCAPE_AFTER = "30";
process.env.DSH_RETRY_STRATEGY_AFTER = "2";

const plugin = await import(new URL("../index.js", import.meta.url).href);
const { _internal } = plugin;

let pass = 0, fail = 0; const fails = [];
async function okA(name, fn) {
	try { await fn(); pass++; console.log("PASS " + name); }
	catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); }
}

function makeCtx() {
	const listeners = {};
	const ctx = {
		on(e, h) { (listeners[e] ||= []).push(h); return () => {}; },
		effect() {},
		logger: { warn() {}, debug() {}, info() {} },
	};
	return { ctx, listeners };
}
function makeAgent(events, id = "s1", origin = "root") {
	return { id, session: { header: { id, origin }, events, append: (type, data) => { events.push({ type, data }); } } };
}
const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const pkey = JSON.stringify(["always", 1, 1, 0]);
async function failOnce(listeners, agent, turn, step, code = "TRANSPORT") {
	return listeners["agent/request-error"][0]({ agent, turn, step, provider: "p", failure: { code }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
}
const preStep = (listeners) => listeners["agent/pre-step"][0];
const enterNext = async () => ({ kind: "enter", messages: [] });
async function ledger() {
	try {
		const raw = await fsp.readFile(join(tempHome, "retry-insights.jsonl"), "utf8");
		return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch { return []; }
}

// T1 写意图判定：写工具/写命令算；只读命令（含 2>&1、=>）不算
await okA("write-intent: write tools and shell writes count, read-only does not", async () => {
	assert.equal(_internal.toolWriteIntent({ name: "write" }), true);
	assert.equal(_internal.toolWriteIntent({ name: "edit", arguments: { path: "a" } }), true);
	assert.equal(_internal.toolWriteIntent({ name: "pwsh", arguments: { command: "Set-Content out.txt hi" } }), true);
	assert.equal(_internal.toolWriteIntent({ name: "pwsh", arguments: { command: "Get-ChildItem | Out-File log.txt" } }), true);
	assert.equal(_internal.toolWriteIntent({ name: "read" }), false);
	assert.equal(_internal.toolWriteIntent({ name: "grep" }), false);
	assert.equal(_internal.toolWriteIntent({ name: "web_search" }), false);
	assert.equal(_internal.toolWriteIntent({ name: "pwsh", arguments: { command: "Get-ChildItem 2>&1 | Select-Object -Last 3" } }), false);
	assert.equal(_internal.toolWriteIntent({ name: "pwsh", arguments: { command: "git status --short" } }), false);
});

// T2 宿主默认策略结构判定（v0.3.11 不再逐字段硬匹配）
await okA("dsh default policy detected structurally, explicit config respected", async () => {
	const dshDefault = { mode: "normal", maxRetries: 5, retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 };
	assert.equal(_internal.isDshDefaultPolicy(dshDefault), true, "exact host default");
	const drifted = { mode: "normal", maxRetries: 3, retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"], initialDelayMs: 800, maxDelayMs: 12000, jitterRatio: 0 };
	assert.equal(_internal.isDshDefaultPolicy(drifted), true, "host default after a version bump");
	assert.equal(_internal.isDshDefaultPolicy({ mode: "normal", maxRetries: 10, retryableCodes: ["SERVER", "TRANSPORT"] }), false, "explicit bigger config");
	assert.equal(_internal.isDshDefaultPolicy({ mode: "always" }), false);
	assert.equal(_internal.isDshDefaultPolicy(undefined), false);
});

// T3 致命码不重试：AUTH 只尝试 1 次，不写 llm/retry
await okA("fatal code (AUTH) is not retried", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "fatal");
	let nextCalls = 0;
	const r = await listeners["agent/request-error"][0]({ agent, turn: 1, step: 1, provider: "p", failure: { code: "AUTH" }, retryPolicy: policy, signal: new AbortController().signal }, async () => { nextCalls++; return "TERMINAL"; });
	assert.equal(r, "TERMINAL");
	assert.equal(nextCalls, 1, "next() called once");
	assert.equal(agent.session.events.filter((e) => e.type === "llm/retry").length, 0, "no retry event");
	const rec = (await ledger()).reverse().find((x) => x.phenomenon === "retry-skipped-fatal" && x.session === "fatal");
	assert.ok(rec, "retry-skipped-fatal ledger record");
});

// T4 指纹截断标记（cap 之外不可见时明确降级，不再误判）
await okA("fingerprint reports truncation when walk cap is hit", async () => {
	const fpDir = await fsp.mkdtemp(join(tmpdir(), "rl-v0311-fp-"));
	await fsp.writeFile(join(fpDir, "a.txt"), "a");
	await fsp.writeFile(join(fpDir, "b.txt"), "b");
	const capped = await _internal.fingerprintDir(fpDir, new Set(), 1);
	assert.equal(capped.truncated, true, "truncated flag set");
	assert.equal(capped.count, 1);
	const full = await _internal.fingerprintDir(fpDir, new Set(), 10);
	assert.equal(full.truncated, false);
	assert.equal(full.count, 2);
	assert.ok(full.fp.includes("a.txt") && full.fp.includes("b.txt"));
});

// T5 风暴时长闸：同一步首败至今 >180s → 止损（不再等满 5×120s）
await okA("storm wall-clock gate trips at 180s", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "storm");
	const t0 = 1000000;
	agent.session.events.push({ type: "llm/retry", time: t0, data: { turn: 2, step: 1, provider: "p", policyKey: pkey, retry: 1, retryId: "s1" } });
	_internal.__setNow(() => t0 + 181000);
	let r;
	try {
		r = await listeners["agent/request-error"][0]({ agent, turn: 2, step: 1, provider: "p", failure: { code: "TIMEOUT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	} finally {
		_internal.__setNow(() => Date.now());
	}
	assert.equal(r, "TERMINAL", "valve returned downstream decision");
	const rec = (await ledger()).reverse().find((x) => x.phenomenon === "storm-timeout" && x.session === "storm");
	assert.ok(rec, "storm-timeout ledger record");
	assert.ok(rec.detail.includes("181") || rec.detail.includes("180"), "detail carries storm duration");
});

// T6 provider 冷却：10 分钟内第 2 次阀 → 冷却；冷却期内失败 1 次即止损
await okA("provider cooldown after two valves in window", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "cool");
	const pushN = (turn, n, provider) => {
		for (let r = 1; r <= n; r++) agent.session.events.push({ type: "llm/retry", time: Date.now(), data: { turn, step: 1, provider, policyKey: pkey, retry: r, retryId: "c" + turn } });
	};
	const call = (turn, provider) => listeners["agent/request-error"][0]({ agent, turn, step: 1, provider, failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	pushN(1, 30, "coolP");
	assert.equal(await call(1, "coolP"), "TERMINAL", "valve #1");
	pushN(2, 30, "coolP");
	assert.equal(await call(2, "coolP"), "TERMINAL", "valve #2");
	pushN(3, 1, "coolP");
	assert.equal(await call(3, "coolP"), "TERMINAL", "cooldown valve after one failure");
	const rows = await ledger();
	assert.ok(rows.some((x) => x.phenomenon === "provider-cooldown"), "provider-cooldown ledger record");
	assert.ok(rows.some((x) => x.phenomenon === "provider-cooldown" && x.session === "cool"), "cooldown valve recorded for session");
});

// T7 风暴已解决 → 不再注入改形状指令
await okA("resolved storm is not escalated on next turn", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "res");
	await failOnce(listeners, agent, 1, 1, "TRANSPORT");
	await failOnce(listeners, agent, 1, 1, "TIMEOUT");
	agent.session.events.push({ type: "step/end", data: { turn: 1, step: 1 } });
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0, "no strategy after step completed");
	const rec = (await ledger()).reverse().find((x) => x.phenomenon === "strategy-skipped-resolved" && x.session === "res");
	assert.ok(rec, "strategy-skipped-resolved ledger record");
});

// T8 注入预算：同一风暴科目最多 3 条，第 4 条被抑制且记账
await okA("injection budget suppresses the 4th strategy injection", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "budget");
	const seen = [];
	for (let i = 0; i < 4; i++) {
		const turn = i + 1;
		await failOnce(listeners, agent, turn, 1, "TRANSPORT");
		await failOnce(listeners, agent, turn, 1, "TIMEOUT");
		const d = await preStep(listeners)({ agent, turn: turn + 1 }, enterNext);
		seen.push(d.messages.length);
	}
	assert.deepEqual(seen.slice(0, 3), [1, 1, 1], "first three injections land (L1, L2, L2)");
	assert.equal(seen[3], 0, "fourth suppressed by budget");
	const sup = (await ledger()).filter((x) => x.phenomenon === "injection-suppressed" && x.session === "budget");
	assert.ok(sup.length >= 1, "injection-suppressed ledger record");
});

// T9 注入文案：前缀标明非用户指令；形状建议 4000 字符；去掉绝对化措辞
await okA("injection carries plugin prefix and 4000-char shape advice", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "text");
	await failOnce(listeners, agent, 1, 1, "TRANSPORT");
	await failOnce(listeners, agent, 1, 1, "TIMEOUT");
	const d = await preStep(listeners)({ agent, turn: 3 }, enterNext);
	const text = d.messages[0].content[0].text;
	assert.ok(text.startsWith("〔自动提示·非用户指令"), "explicit non-user prefix");
	assert.ok(text.includes("4000"), "4000-char cap");
	assert.ok(!text.includes("不可救药"), "no absolute wording");
});

// T10 只读轮不触发伪进度注入（含 2>&1 的 pwsh 不算写意图）
await okA("read-only tool turn is not pseudo-progress", async () => {
	const { ctx, listeners } = makeCtx(); plugin.apply(ctx);
	const agent = makeAgent([], "ro");
	const onTool = listeners["tools/post-execute"][0];
	await preStep(listeners)({ agent, turn: 1 }, enterNext);
	await onTool({ agent, name: "pwsh", arguments: { command: "Get-ChildItem 2>&1" } }, null, async () => "ok");
	await listeners["agent/turn-stopping"][0]({ agent });
	const d = await preStep(listeners)({ agent, turn: 2 }, enterNext);
	assert.equal(d.messages.length, 0, "no progress-warning for read-only turn");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));
process.exit(fail ? 1 : 0);

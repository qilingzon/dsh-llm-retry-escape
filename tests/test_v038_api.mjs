// test_v038_api.mjs — v0.3.8：DSH 2.0.9 会话事件 API 兼容（致命回归）
// 背景：2.0.9 起 Session 不再有 `.events`，旧写法 agent.session.events.findLast(...) 抛
// TypeError: Cannot read properties of undefined (reading 'findLast') → 整轮失败。
// 本测试锁死四种会话形状：snapshotEvents()（新）/ .events（旧）/ 两者皆无 / snapshotEvents 抛错。
import assert from "node:assert/strict";

const plugin = await import(new URL("../index.js", import.meta.url).href);

const ESCAPE_AFTER = (() => {
	const n = Number(process.env.DSH_RETRY_ESCAPE_AFTER);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
})();

const policy = { mode: "always", initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
const key = JSON.stringify(["always", 1, 1, 0]);

let pass = 0, fail = 0;
function check(ok, label) {
	if (ok) { pass++; console.log(`  ok - ${label}`); }
	else { fail++; console.log(`  FAIL - ${label}`); }
}

function makeCtx(logs) {
	const listeners = {};
	return {
		listeners,
		ctx: {
			on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
			effect() {},
			logger: { warn: (...a) => logs.push(a.map(String).join(" ")), debug: () => {}, info: () => {} },
		},
	};
}

async function runCase(label, makeSession) {
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const session = makeSession();
	const agent = { id: "a-" + label, session };
	const payload = { agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal };
	let threw = null;
	let result;
	try {
		result = await onRequestError(payload, async () => "TERMINAL");
	} catch (e) {
		threw = e;
	}
	return { threw, result, logs, session };
}

// 预填 ESCAPE_AFTER 条 llm/retry —— 阀必须点火（返回下游终值，而非抛错）
function prefill(events, n) {
	for (let r = 1; r <= n; r++) events.push({ type: "llm/retry", data: { turn: 1, step: 1, provider: "p", policyKey: key, retry: r, retryId: "rid" } });
}

// ── 形状 A：DSH 2.0.9（只有 snapshotEvents()，没有 .events 属性） ──
{
	const events = [];
	const r = await runCase("shape-A", () => ({
		header: { id: "sA", origin: "root" },
		snapshotEvents: () => events,
		append: (t, d) => events.push({ type: t, data: d }),
	}));
	check(r.threw === null, `A 新 API 不抛错（threw=${r.threw && r.threw.message}）`);
	check(!/findLast/.test(String(r.threw && r.threw.message)), "A 无 findLast TypeError");
}
{
	const events = [];
	prefill(events, ESCAPE_AFTER);
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const agent = { id: "a-A2", session: { header: { id: "sA2", origin: "root" }, snapshotEvents: () => events, append: (t, d) => events.push({ type: t, data: d }) } };
	let threw = null, result;
	try {
		result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	} catch (e) { threw = e; }
	check(threw === null, "A 阀路径不抛错（旧写法正是在这里炸）");
	check(result === "TERMINAL", `A 连败 ${ESCAPE_AFTER} 次后阀点火交还上层（result=${JSON.stringify(result)}）`);
	check(logs.some((l) => l.includes("escape valve")), "A 阀日志已出");
}

// ── 形状 B：旧版 / 测试桩（只有 .events 数组） ──
{
	const events = [];
	prefill(events, ESCAPE_AFTER);
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const agent = { id: "a-B", session: { header: { id: "sB", origin: "root" }, events, append: (t, d) => events.push({ type: t, data: d }) } };
	const result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	check(result === "TERMINAL", "B 旧 .events 形状仍兼容（阀点火）");
}

// ── 形状 C：两者皆无（退化形状）→ 必须当 0 次失败处理，安排重试而不是抛错 ──
{
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const agent = { id: "a-C", session: { header: { id: "sC", origin: "root" }, append: () => {} } };
	let threw = null, result;
	try {
		result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	} catch (e) { threw = e; }
	check(threw === null, "C 空事件形状不抛错");
	check(result && result.kind === "retry", `C 无失败史 → 正常安排重试（result=${JSON.stringify(result)}）`);
}

// ── 形状 D：snapshotEvents() 自身抛错 → 吞掉异常，不污染主循环 ──
{
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const agent = { id: "a-D", session: { header: { id: "sD", origin: "root" }, snapshotEvents: () => { throw new Error("snapshot exploded"); }, append: () => {} } };
	let threw = null, result;
	try {
		result = await onRequestError({ agent, turn: 1, step: 1, provider: "p", failure: { code: "TRANSPORT" }, retryPolicy: policy, signal: new AbortController().signal }, async () => "TERMINAL");
	} catch (e) { threw = e; }
	check(threw === null, "D snapshot 抛错被吞（不外溢到 agent-loop）");
	check(result && result.kind === "retry", `D 退化为无失败史并按策略重试（result=${JSON.stringify(result)}）`);
}

console.log(`RESULT pass=${pass} fail=${fail} (v0.3.8 session API compat)`);

// 测试结果入洞察账本（设置页「反卡死历史」面板可见）
try {
	plugin._internal.appendInsight({
		source: "test-suite",
		session: "tests/test_v038_api.mjs",
		workspace: process.cwd(),
		phenomenon: "test",
		detail: `test_v038_api v0.3.8: 会话事件 API 兼容 ${pass}/${pass + fail}（snapshotEvents 新形状 / .events 旧形状 / 空形状 / snapshot 抛错）`,
		resolved: fail === 0 ? "全部通过" : "存在失败",
		lesson: "DSH 2.0.9 移除 Session.events——插件取事件必须走 snapshotEvents() 兼容层，异常绝不外溢主循环",
	});
} catch { /* 账本失败不影响退出码 */ }

process.exit(fail === 0 ? 0 : 1);

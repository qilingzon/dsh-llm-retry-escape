// test_v039_fallback.mjs — v0.3.9 通用兜底重试测试
import assert from "node:assert/strict";

const plugin = await import(new URL("../index.js", import.meta.url).href);

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

// Case 1: retryPolicy is undefined (e.g. provider "r4" or "cpa") -> should fallback to universal policy and retry!
{
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const events = [];
	const session = {
		header: { id: "s-unconfigured-r4", origin: "root" },
		snapshotEvents: () => events,
		append: (t, d) => events.push({ type: t, data: d }),
	};
	const agent = { id: "a-r4", session };
	const payload = {
		agent,
		turn: 1,
		step: 1,
		provider: "r4",
		failure: { code: "PI_AI_ERROR", message: "The service is temporarily unavailable." },
		retryPolicy: undefined, // 未配置任何 retryPolicy
		signal: new AbortController().signal,
	};
	const result = await onRequestError(payload, async () => "DOWNSTREAM_FALLTHROUGH");
	check(result?.kind === "retry", `Case 1: 未配置 retryPolicy 的 r4 自动套用通用兜底策略，触发重试 (result=${JSON.stringify(result)})`);
	check(events.some(e => e.type === "llm/retry"), "Case 1: 成功追加 llm/retry 事件");
	check(events.some(e => e.type === "llm/retry-started"), "Case 1: 成功追加 llm/retry-started 事件");
}

// Case 2: Explicit custom retryPolicy is respected
{
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const events = [];
	const session = {
		header: { id: "s-custom-policy", origin: "root" },
		snapshotEvents: () => events,
		append: (t, d) => events.push({ type: t, data: d }),
	};
	const agent = { id: "a-custom", session };
	const customPolicy = {
		mode: "normal",
		maxRetries: 2,
		retryableCodes: ["RATE_LIMIT"],
		initialDelayMs: 1,
		maxDelayMs: 1,
		jitterRatio: 0,
	};
	const payload = {
		agent,
		turn: 1,
		step: 1,
		provider: "custom",
		failure: { code: "NON_RETRYABLE" },
		retryPolicy: customPolicy,
		signal: new AbortController().signal,
	};
	const result = await onRequestError(payload, async () => "DOWNSTREAM_FALLTHROUGH");
	check(result === "DOWNSTREAM_FALLTHROUGH", "Case 2: 显式自定义策略（normal 且 code 不匹配）优先尊重，不强行兜底");
}

// Case 3 (v0.3.10): DSH native default-injected policy -> should be upgraded to universal fallback and retry!
{
	const logs = [];
	const { listeners, ctx } = makeCtx(logs);
	plugin.apply(ctx);
	const onRequestError = listeners["agent/request-error"][0];
	const events = [];
	const session = {
		header: { id: "s-dsh-default-r4", origin: "root" },
		snapshotEvents: () => events,
		append: (t, d) => events.push({ type: t, data: d }),
	};
	const agent = { id: "a-dsh-default", session };
	// DSH 宿主在未配置 retryPolicy 时注入的原生默认对象
	const dshDefaultPolicy = {
		mode: "normal",
		maxRetries: 5,
		retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
		initialDelayMs: 500,
		maxDelayMs: 10000,
		jitterRatio: 0.1,
	};
	const payload = {
		agent,
		turn: 1,
		step: 1,
		provider: "r4",
		failure: { code: "PI_AI_ERROR", message: "The service is temporarily unavailable." },
		retryPolicy: dshDefaultPolicy,
		signal: new AbortController().signal,
	};
	const result = await onRequestError(payload, async () => "DOWNSTREAM_FALLTHROUGH");
	check(result?.kind === "retry", "Case 3: 宿主默认注入的 normal 策略被成功拦截并升级为 always 通用兜底重试");
	check(events.some(e => e.type === "llm/retry"), "Case 3: llm/retry 记录成功追加");
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);

/**
 * dsh-llm-retry-escape — 反卡死插件 v0.3.4（通用版，替代内置 @deepseek-ai/dsh-llm-retry）
 *
 * 功能 A（request 层）：always 重试逃生阀 + 探测节奏封顶
 *   A1) 逃生阀：同一 (turn, step, provider, policy) 连续失败 N 次后停止为本轮安排重试，
 *       失败交还上层（goal 自动续跑 / run_longtask.ps1 接力器）重发新请求。
 *       DSH_RETRY_ESCAPE_AFTER 调整阈值，0 = 关闭。默认 30。改后需重启 Host。
 *   A2) 探测节奏：重试间隔硬封顶 5 秒（v0.3.1 起由 30s 收紧，用户要求）——网络恢复后
 *       ≤5s 必发出下一次重连。
 *
 * 功能 B（turn 层，通用自动）：磁盘进度哨兵 —— 活锁/伪进度检测
 *   自动监视每个根会话自己的工作区（agent.session.header.cwd，可用 DSH_PROGRESS_WATCH_DIR
 *   全局覆盖为固定目录）。判定纪律：
 *     - 轮内调用过工具（在干活）但工作区指纹零变化 → 记 zeroStreak（伪进度嫌疑）
 *     - 纯聊天轮（未调用工具）不惩罚——聊天本来就不写盘
 *     - 出现真实落盘 → streak 清零并记「伪进度解除」
 *     - streak≥1 下一轮注入 progress-warning；streak≥2 升级"必须换方法"
 *   指纹排除 node_modules/.git/.venv/venv/__pycache__（DSH_PROGRESS_EXCLUDES 可追加），
 *   走查上限 20000 项（防超大仓库拖慢）。
 *
 * 功能 C（v0.3.0）：洞察账本 + 设置页「反卡死历史」面板（通用：任何项目）
 *   检测事件追加到 $DSH_HOME\retry-insights.jsonl（时间/会话/工作区/现象/状态/经验）；
 *   宿主注册 GET /api/dsh-llm-retry-escape/insights（仅 loopback）；
 *   客户端在 设置 → 反卡死历史 渲染历史表（5s 轮询）。
 *   外层接力器 run_longtask.ps1 亦向同一账本写入止损记录（超时/活锁/伪进度/负进度回滚）。
 *
 * 功能 D（turn 层，opt-in）：负进度/静默腐蚀校验门 —— 第 4、5 种现象的监测
 *   设 DSH_PROGRESS_CHECK_CMD=<命令> 启用：工作区出现变化后自动运行校验（cwd=工作区，
 *   DSH_PROGRESS_CHECK_TIMEOUT_MS 超时，默认 120s，退出码 0=通过）。
 *   失败 → 记 regression 账本（负进度/腐蚀嫌疑）+ 下一轮注入校验警告（含输出尾部）；
 *   恢复通过 → 记 regression-resolved。**校验写多深，腐蚀防线就多深——没有银弹**。
 *
 * normal 模式与内置实现逐字一致；事件流与内置同形，UI 计数与会话不变式不受影响。
 *
 * v0.3.1：insightsPath 改为每次动态读取 DSH_HOME（运行期改 env 也生效）；导出 _internal
 * （appendInsight / makeInsightsRoute / insightsPath）供测试套件复用——测试结果以「test」
 * 现象写入同一账本，设置页「反卡死历史」面板可见（客户端 client.js 同步加 test 标签）。
 * A2 探测封顶同步收紧 30s→5s（用户要求）。
 *
 * v0.3.2：C 扩展「发现/解决即记账」——always 模式每次失败进账本（retry-detected），
 * 重试后该步完成记 retry-resolved（含发现→解决全程秒数），「反卡死历史」面板不再
 * 只显示病理判决；normal 模式保持与内置逐字一致，不记账。
 *
 * v0.3.3：A1 补全「止损 → 接力」断链——阀收尾的轮以失败态结束，Host 的 goal-round-driver
 * 会因 agent/error 解除 goal 自动续跑武装（disarm），任务停摆等人工。本版监听 agent/status：
 * 阀收尾的轮一空闲立即 ctx.goals.resume 重新武装（active+disarmed → active+armed），
 * goal/change(resume) 反向触发驱动器排队下一轮，恢复「正常轮结束 → 秒级自动接力」的
 * 无人值守链路；轮预算仍由 goal.maxGoalRounds 封顶，不会无限空烧。现象记 relay-rearmed。
 *
 * v0.3.4：A1-Coach 失败步策略注入——同一 (turn, step) 连败 ≥ DSH_RETRY_STRATEGY_AFTER（默认 2）
 * 次时，在下一轮 pre-step 注入「改变生成形状」策略消息（复用 progress-warning 管道）：
 * 小块输出 / 分块 append / 禁单次巨型生成。治本：中继掐长流是内容形状相关的确定性失败，
 * 重试与接力只是重发同样的巨型生成（armor-lab 实证 4.5h 40+ 败 0 文件落盘）——只有让
 * 每次尝试的生成时长降到中继杀手窗口以下，风暴才会真正消失。现象记 strategy-injected。
 * 注入时机为下一轮入口：agent-loop 步内重试间无任何可注入钩子（步内插消息会破坏会话不变式）。
 *
 * v0.3.6：A1-Coach 升级阶梯——策略注入不再原地重复：注入后风暴仍在（下一轮入口仍有待注入
 * 记录）→ 阶梯+1，第 2 级起改发「拆任务」升级话术（拆小步/缩减版骨架/blocked 换路径，
 * 现象 strategy-escalated）；风暴痊愈（某轮入口无待注入记录）→ 阶梯复位。
 * DSH_RETRY_STRATEGY_MAX_LEVEL：默认 2；1=永不升级；0=关闭整个策略注入。
 */

import { randomUUID } from "node:crypto";
import { promises as fsp, appendFileSync, existsSync, readFileSync, statSync, renameSync } from "node:fs";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const ESCAPE_AFTER = (() => {
	const raw = process.env.DSH_RETRY_ESCAPE_AFTER;
	if (raw === void 0 || raw === "") return 30;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
})();
const ESCALATE_MAX_DELAY_MS = 5000;

// v0.3.5：config-disease 诊断的间隔下限（中位失败间隔低于此值不判配置病；测试可调小）
const CONFIG_DISEASE_MIN_MS = (() => {
	const n = Number(process.env.DSH_CONFIG_DISEASE_MIN_MS);
	return Number.isFinite(n) && n >= 0 ? n : 20000;
})();

// v0.3.5：B 哨兵只认"可能落盘"的工具——纯读取/检索/清单类工具不构成干活证据（降误报）。
// bash/pwsh 等可写工具仍计入（保守：指纹本身就是最终裁判）。
const READ_ONLY_TOOL_RE = /read|glob|grep|search|fetch|todo|view|open|list|web|ask|skill|think|goal|plan/i;

// v0.3.4：同一 (turn, step) 连败多少次后，下一轮注入「改变生成形状」策略（0 = 关闭）
const STRATEGY_AFTER = (() => {
	const raw = process.env.DSH_RETRY_STRATEGY_AFTER;
	if (raw === void 0 || raw === "") return 2;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();

// v0.3.6：策略注入升级阶梯上限——2=第二次注入起升级「拆任务」（默认）；1=永不升级；0=关闭整个策略注入
const STRATEGY_MAX_LEVEL = (() => {
	const raw = process.env.DSH_RETRY_STRATEGY_MAX_LEVEL;
	if (raw === void 0 || raw === "") return 2;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();

// 可选：全局覆盖哨兵监听目录（默认自动监视各会话自己的工作区）
const PROGRESS_WATCH_DIR_OVERRIDE = (process.env.DSH_PROGRESS_WATCH_DIR || "").trim();
const PROGRESS_EXCLUDES = new Set([
	"node_modules", ".git", ".venv", "venv", "__pycache__",
	...(process.env.DSH_PROGRESS_EXCLUDES || "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const PROGRESS_MAX_WALK = 20000;

// ── D：负进度/静默腐蚀校验门 ──
const CHECK_CMD = (process.env.DSH_PROGRESS_CHECK_CMD || "").trim();
const CHECK_TIMEOUT_MS = (() => {
	const n = Number(process.env.DSH_PROGRESS_CHECK_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120000;
})();
// 测试钩子：注入模拟执行器后不再真实 spawn（受限环境/单测用；生产路径不受影响）
let checkRunner = null;
function runCheckCmd(cwd) {
	return new Promise((resolve) => {
		if (checkRunner) {
			resolve(checkRunner(CHECK_CMD, cwd));
			return;
		}
		try {
			exec(CHECK_CMD, { cwd, timeout: CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
				const output = (String(stdout || "") + String(stderr || "")).trim();
				resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, output: output.slice(-600) });
			});
		} catch (e) {
			// 子进程无法创建（受限环境）——按校验失败处理，绝不打断哨兵簿记
			resolve({ ok: false, code: (e && e.code) ?? 1, output: ("check spawn failed: " + String((e && e.message) || e)).slice(-600) });
		}
	});
}
const CHECK_WARN_PREFIX =
	"[progress-sentinel] 上一轮的工作区改动未通过校验——负进度/静默腐蚀嫌疑：改动可能破坏了已有成果，或引入了未报错的问题。本轮先重新运行校验命令定位，修复至校验转绿后，再继续新增改动。校验输出尾部：";

// ── C：洞察账本 ──
// 动态读取：每次调用时取 DSH_HOME（v0.3.1 起不再在 import 时固化，运行期改 env 也生效）
function insightsPath() {
	return process.env.DSH_HOME
		? pathJoin(process.env.DSH_HOME, "retry-insights.jsonl")
		: pathJoin(homedir(), ".dsh", "retry-insights.jsonl");
}
// v0.3.7：账本大小轮转——现有文件 + 本条将超上限（DSH_RETRY_LEDGER_MAX_BYTES，默认 5MB，0=关闭）
// 时，先把现文件改名归档（时间戳后缀），再从头追加。动态读 env（与 insightsPath 同语义，测试可调）。
// 归档失败（Windows 文件被占用等）不阻塞记账：跳过本轮轮转照常追加。
function ledgerMaxBytes() {
	const n = Number(process.env.DSH_RETRY_LEDGER_MAX_BYTES);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5 * 1024 * 1024;
}
function rotateLedgerIfNeeded(file, incomingBytes) {
	const max = ledgerMaxBytes();
	if (max <= 0 || !existsSync(file)) return;
	try {
		if (statSync(file).size + incomingBytes <= max) return;
		const archive = file.replace(/\.jsonl$/, "") + "-archive-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl";
		renameSync(file, archive);
	} catch {
		// 归档失败照常追加（顶多超限一点，下轮再试）
	}
}
function appendInsight(record) {
	try {
		const file = insightsPath();
		const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
		rotateLedgerIfNeeded(file, line.length);
		appendFileSync(file, line);
	} catch {
		// 账本永不破坏主循环
	}
}
function writeJson(res, code, body) {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}
function isLoopbackRequest(req) {
	const addr = req?.socket?.remoteAddress || "";
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function makeInsightsRoute() {
	return {
		kind: "exact",
		path: "/api/dsh-llm-retry-escape/insights",
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) {
				writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
				return;
			}
			let records = [];
			try {
				const insightsFile = insightsPath();
				if (existsSync(insightsFile)) {
					records = readFileSync(insightsFile, "utf8")
						.split("\n")
						.filter((line) => line.trim())
						.map((line) => {
							try { return JSON.parse(line); } catch { return { ts: "?", phenomenon: "unparsable", detail: line.slice(0, 120) }; }
						})
						.reverse();
				}
			} catch {
				// 读失败返回空
			}
			// v0.3.7：limit 截断——默认返回最近 500 条，?limit=N 可调；total 为账本总条数。
			// 面板体量与账本体量解耦：账本涨到几十 MB 时面板每次只传最近窗口。
			const total = records.length;
			let limit = 500;
			try {
				const m = String(req.url || "").match(/[?&]limit=(\d{1,6})(?:&|$)/);
				if (m) limit = Math.max(1, Math.min(Number(m[1]), 1000000));
			} catch {
				// 解析失败用默认值
			}
			records = records.slice(0, limit);
			writeJson(res, 200, { ok: true, count: records.length, total, limit, records });
		},
	};
}

// ── C(v0.3.2)：重试解决记账 —— 某步带失败史且最终完成（step/end）→ 记 retry-resolved ──
// resolvedLogged：按会话传入的 Set<"turn/step">，去重保证同一步只记一次
function logRetryResolutions(agent, resolvedLogged) {
	const events = agent.session?.events;
	if (!Array.isArray(events)) return;
	const sid = agent.session?.header?.id || "";
	const cwd = agent.session?.header?.cwd || "";
	const fails = new Map(); // "turn/step" -> {turn, step, provider, count, codes[], firstTime}
	for (const e of events) {
		if (e?.type !== "llm/retry") continue;
		const key = (e.data?.turn ?? "?") + "/" + (e.data?.step ?? "?");
		const rec = fails.get(key) || { turn: e.data?.turn, step: e.data?.step, provider: e.data?.provider || "?", count: 0, codes: [], firstTime: e.time || 0 };
		rec.count += 1;
		if (e.data?.failure?.code && !rec.codes.includes(e.data.failure.code)) rec.codes.push(e.data.failure.code);
		fails.set(key, rec);
	}
	if (fails.size === 0) return;
	for (const e of events) {
		if (e?.type !== "step/end") continue;
		const key = (e.data?.turn ?? "?") + "/" + (e.data?.step ?? "?");
		const rec = fails.get(key);
		if (!rec || resolvedLogged.has(key)) continue;
		resolvedLogged.add(key);
		appendInsight({
			source: "plugin",
			session: sid,
			workspace: cwd,
			phenomenon: "retry-resolved",
			detail: `${rec.provider} turn${rec.turn}/step${rec.step} 历经 ${rec.count} 次失败（${rec.codes.join("/")}）后该步完成`,
			resolved: "已解决：重试成功",
			lesson: `发现→解决全程 ${Math.round(((e.time || 0) - rec.firstTime) / 1000)}s`,
		});
	}
}

function escalatedMaxDelayMs(policy, previousRetry) {
	const tier = Math.min(Math.floor(previousRetry / 10), 8);
	return Math.min(policy.maxDelayMs * 2 ** tier, ESCALATE_MAX_DELAY_MS);
}

function RetryId(id) {
	return id;
}

async function settleDownstream(next) {
	try {
		return { type: "decision", decision: await next() };
	} catch (error) {
		return { type: "error", error };
	}
}

function localDelay(config, retry, random) {
	const exponent = Math.min(retry - 1, 1024);
	const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
	const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
	return Math.min(exponential * jitter, config.maxDelayMs);
}

function retryPolicyKey(policy) {
	return policy.mode === "always" ? JSON.stringify([
		policy.mode,
		policy.initialDelayMs,
		policy.maxDelayMs,
		policy.jitterRatio
	]) : JSON.stringify([
		policy.mode,
		policy.maxRetries,
		[...policy.retryableCodes].sort(),
		policy.initialDelayMs,
		policy.maxDelayMs,
		policy.jitterRatio
	]);
}

function cancellableDelay(delayMs, signal) {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// ── B：磁盘指纹（只取元数据；走查上限防超大仓库）──
async function fingerprintDir(root, excludes, maxWalk) {
	const out = [];
	async function walk(dir, rel) {
		if (out.length >= maxWalk) {
			out.push("..cap..");
			return;
		}
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of entries) {
			if (out.length >= maxWalk) { out.push("..cap.."); return; }
			if (excludes.has(entry.name)) continue;
			const relPath = rel ? rel + "/" + entry.name : entry.name;
			const fullPath = pathJoin(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath, relPath);
			} else if (entry.isFile()) {
				try {
					const st = await fsp.stat(fullPath);
					out.push(relPath + "|" + st.size + "|" + st.mtimeMs);
				} catch {
					out.push(relPath + "|?");
				}
			}
		}
	}
	await walk(root, "");
	return out.join("\n");
}

function progressNotice(text, tag, form = "progress-warning") {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: {
			kind: "plugin",
			plugin: "dsh-llm-retry-escape",
			form,
			summary: tag,
		},
	};
}

const PROGRESS_WARN_1 =
	"[progress-sentinel] 上一轮调用了工具但在工作区零落盘——你在伪进度空转。本轮第一件事：用写入工具真实更新 progress.md 的当前动作行，然后用读取工具回读确认已写入，再继续任务。禁止把\"已写入/已完成\"只写在回复文本里——一切以磁盘文件为准。";
function progressWarnN(streak) {
	return (
		"[progress-sentinel] 连续 " + streak + " 轮调用工具但工作区零落盘——当前策略已被证实无效，禁止再重复。本轮必须：1) 先检查写入路径是否正确、写文件操作是否被沙箱拒绝；2) 把判定结论写进 progress.md；3) 执行最小一步真实落盘并回读验证，之后才允许继续任务。"
	);
}

// v0.3.4/v0.3.5：失败步策略注入文本——按失败码自适应话术（把「换新请求」变成对症指令）
function strategyWarnText(count, codes, turn, step) {
	const c = codes.join("/");
	const has = (x) => codes.includes(x);
	const rateOnly = codes.length === 1 && has("RATE_LIMIT");
	const serverish = !has("TRANSPORT") && !has("TIMEOUT") && (has("SERVER") || has("INVALID_REQUEST"));
	if (rateOnly) {
		// 限流/配额类：输出体积无罪，节奏才有罪
		return (
			`[retry-strategy] 上一轮的 turn${turn}/step${step} 已连续失败 ${count} 次（${c}）——全部是限流/配额类失败，不是你的输出问题。本轮调整节奏而非内容：` +
			"1) 串行小步执行，禁止并行大批量工具调用；" +
			"2) 步与步之间留出间隔，避免密集请求；" +
			"3) 不要用加大请求体积的方式「挽回时间」；" +
			"4) 若继续连败 429，说明中继配额窗口未恢复——把当前进展写入 progress.md 稍作等待再继续，必要时告知用户考虑切换 provider。"
		);
	}
	if (serverish) {
		// 网关/上游不稳（5xx/400）：内容无罪，小步快走 + 别硬冲
		return (
			`[retry-strategy] 上一轮的 turn${turn}/step${step} 已连续失败 ${count} 次（${c}）——中继网关/上游不稳定。本轮：` +
			"1) 保持小步快走，单次工具调用 ≤1500 字符，失败原样重试不必改写内容；" +
			"2) 每步落盘验证后再走下一步；" +
			"3) 避免一次性大请求（网关对长请求更脆弱）；" +
			"4) 连续 502/504 时等待数秒再试，不要连续硬冲。"
		);
	}
	// 掐流/停滞类（TRANSPORT/TIMEOUT）：生成形状是主因
	return (
		`[retry-strategy] 上一轮的 turn${turn}/step${step} 已连续失败 ${count} 次（${c}）——流式生成在传输层被反复掐断。` +
		"重发同样的请求只会同样死掉：失败的直接原因是单次生成的输出体积太大、时长超出中继存活窗口。本轮必须改变生成形状：" +
		"1) 单次工具调用参数 ≤1500 字符；" +
		"2) 大文件先写最小骨架（几十行占位），再用多次编辑/追加每次只补 1-2 段，写一段验证一段；" +
		"3) 一次只处理一个文件，禁止并行写多个大文件；" +
		"4) 严禁在回复文本里流式输出完整大文件内容——内容只进工具参数；" +
		"5) 每完成一段立即回读确认，再进行下一段。"
	);
}

// v0.3.6：升级话术——L1 形状策略注入后风暴未止（连败到阀止损），同一 agent 第 2 次注入起改发：
// 按当前粒度已证明不可救，必须先拆任务再干活（拆小步/缩减版骨架/换路径）
function strategyEscalateText(count, codes, turn, step) {
	const c = codes.join("/");
	return (
		`[retry-strategy·升级] turn${turn}/step${step} 已在生成形状策略注入后仍连败 ${count} 次（${c}）并触发阀止损——这一步按当前粒度已证明不可救药，禁止再原样重发。本轮先拆任务再干活：` +
		"1) 立即把该步拆成 ≥3 个可独立验证的小步，写进 progress.md 或任务清单（每小步产物 = 一个文件或一段落）；" +
		"2) 本轮只执行第一个小步，落盘+回读验证后即停，其余小步留给后续轮次；" +
		"3) 若该步的成品必然巨大，先交付可运行的缩减版骨架，完整版分多轮补齐；" +
		"4) 若拆小后仍连败，把该步标记 blocked 并换实现路径（换工具/换文件切分/换方案），不要硬冲。"
	);
}

export const name = "dsh-llm-retry-escape";
export const inject = ["agents", "webServer", "goals"];

/** 测试钩子（v0.3.1）：复用账本与路由实现，测试结果也进「反卡死历史」面板 */
export const _internal = { appendInsight, makeInsightsRoute, insightsPath, __setCheckRunner: (fn) => { checkRunner = fn; } };

export function apply(ctx) {
	const random = Math.random;
	const lifetime = new AbortController();
	const active = /* @__PURE__ */ new Set();
	const valveRelayPending = /* @__PURE__ */ new Set(); // v0.3.3：阀收尾后待重新武装 goal 的 agentId
	const strategyPending = /* @__PURE__ */ new Map(); // v0.3.4：agentId -> {turn, step, count, codes[]} 待注入策略
	const strategyLadder = /* @__PURE__ */ new Map(); // v0.3.6：agentId -> {level, injectedTurn} 策略升级阶梯
	function track(operation) {
		const tracked = operation.finally(() => active.delete(tracked));
		active.add(tracked);
		return tracked;
	}

	async function backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal) {
		const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
		if (fusedSignal.aborted) return;
		const eventData = policy.mode === "normal" ? {
			retryId,
			turn,
			step,
			provider,
			mode: policy.mode,
			policyKey,
			retry,
			maxRetries: policy.maxRetries,
			delayMs,
			failure
		} : {
			retryId,
			turn,
			step,
			provider,
			mode: policy.mode,
			policyKey,
			retry,
			delayMs,
			failure
		};
		agent.session.append("llm/retry", eventData);
		if (policy.mode === "always") {
			// C(v0.3.2)：发现即记账——每次失败进「反卡死历史」（normal 模式保持与内置逐字一致，不记账）
			appendInsight({
				source: "plugin",
				session: agent.session?.header?.id || "",
				workspace: agent.session?.header?.cwd || "",
				phenomenon: "retry-detected",
				detail: `${provider} turn${turn}/step${step} 第 ${retry} 次失败（${failure?.code || "?"}：${String(failure?.message || "").slice(0, 80)}），${Math.round(delayMs / 1000)}s 后重试`,
				resolved: "已安排重试",
				lesson: "发现本身要可见——失败不是静默的",
			});
			// A1-Coach(v0.3.4/v0.3.5)：记录连败风暴（每次失败都更新；阈值在消费端判——首败的失败码也要进账）
			// times[]：失败时刻序列，供 config-disease 诊断（同码连败 + 间隔≈常数 = 配置病）
			const prev = strategyPending.get(agent.id);
			const sameStep = prev && prev.turn === turn && prev.step === step;
			const codes = sameStep ? prev.codes : [];
			if (!codes.includes(failure?.code || "?")) codes.push(failure?.code || "?");
			const times = sameStep && Array.isArray(prev.times) ? prev.times : [];
			times.push(Date.now());
			const recStorm = { turn, step, count: retry, codes, times, configLogged: sameStep ? prev.configLogged : false };
			strategyPending.set(agent.id, recStorm);
			// v0.3.5：config-disease 自动诊断——"Request timed out." 同码连败且失败间隔≈常数
			// → 活请求被整请求超时上限当死请求杀，属配置病（插件治不了，账本报给用户调 settings）
			if (times.length >= 3 && /request timed out/i.test(String(failure?.message || ""))) {
				const gaps = times.slice(1).map((t, i) => t - times[i]);
				const sorted = [...gaps].sort((a, b) => a - b);
				const med = sorted[Math.floor(sorted.length / 2)];
				const spread = Math.max(...gaps) - Math.min(...gaps);
				if (med >= CONFIG_DISEASE_MIN_MS && spread < med * 0.4 && !recStorm.configLogged) {
					recStorm.configLogged = true;
					appendInsight({
						source: "plugin",
						session: agent.session?.header?.id || "",
						workspace: agent.session?.header?.cwd || "",
						phenomenon: "config-disease",
						detail: `turn${turn}/step${step} "Request timed out." 同码连败且间隔恒定（中位 ${Math.round(med / 1000)}s，极差 ${Math.round(spread / 1000)}s）——疑似 provider timeoutMs 过小：max 推力的思考期被整请求上限当死请求杀`,
						resolved: "已记配置病诊断（请调大 settings.yaml 的 provider timeoutMs，建议 ≥ 中位间隔×2）",
						lesson: "配置病和代码病分开治——插件报警，settings 治病",
					});
				}
			}
		}
		if (!await cancellableDelay(delayMs, fusedSignal)) return;
		agent.session.append("llm/retry-started", {
			retryId,
			turn,
			step,
			retry
		});
		return { kind: "retry" };
	}

	async function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
		if (policy === void 0) return next();
		if (policy.mode === "always") {
			if (signal.aborted || lifetime.signal.aborted) return;
			const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
			const downstream = await settleDownstream(next);
			if (fusedSignal.aborted) return;
			if (downstream.type === "error") ctx.logger.warn(`llm-retry-escape: provider "${provider}" always policy ignored a downstream recovery failure: %o`, downstream.error);
			if (downstream.type === "decision" && downstream.decision?.kind === "retry") return downstream.decision;
			// ── A1 逃生阀 + A2 探测节奏封顶 ──
			if (ESCAPE_AFTER > 0) {
				const policyKey = retryPolicyKey(policy);
				const priorPolicyRetry = agent.session.events.findLast((event) => event.type === "llm/retry" && event.data.turn === turn && event.data.step === step && event.data.provider === provider && event.data.policyKey === policyKey);
				const previousRetry = priorPolicyRetry?.data.retry ?? 0;
				if (previousRetry >= ESCAPE_AFTER) {
					ctx.logger.warn(`llm-retry-escape: provider "${provider}" escape valve: ${previousRetry} consecutive failures on turn ${turn} step ${step} — ending the turn for upstream relay`);
					valveRelayPending.add(agent.id);   // v0.3.3：本轮结束后由 agent/status(idle) 重新武装 goal，自动接力
					appendInsight({
						source: "plugin",
						session: agent.session?.header?.id || "",
						workspace: agent.session?.header?.cwd || "",
						phenomenon: "deadloop",
						detail: `${provider} turn${turn}/step${step} 连败 ${previousRetry} 次（${failure?.code || "?"}）`,
						resolved: "已收尾本轮，待上层接力",
						lesson: "确定性失败重试无解——收尾后换新请求（新措辞/新方法）才是出路",
					});
					if (downstream.type === "error") throw downstream.error;
					return downstream.decision;
				}
				const retry = previousRetry + 1;
				const retryId = priorPolicyRetry?.data.retryId ?? RetryId(randomUUID());
				const capped = { ...policy, maxDelayMs: escalatedMaxDelayMs(policy, previousRetry) };
				let delayMs;
				if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > capped.maxDelayMs) delayMs = localDelay(capped, retry, random);
				else delayMs = failure.providerRetryAfterMs;
				else delayMs = localDelay(capped, retry, random);
				return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal);
			}
		} else if (!policy.retryableCodes.includes(failure.code)) return next();
		const policyKey = retryPolicyKey(policy);
		const priorPolicyRetry = agent.session.events.findLast((event) => event.type === "llm/retry" && event.data.turn === turn && event.data.step === step && event.data.provider === provider && event.data.policyKey === policyKey);
		const previousRetry = priorPolicyRetry?.data.retry ?? 0;
		if (policy.mode === "normal" && previousRetry >= policy.maxRetries) return next();
		const retry = previousRetry + 1;
		const retryId = priorPolicyRetry?.data.retryId ?? RetryId(randomUUID());
		let delayMs;
		if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > policy.maxDelayMs) {
			if (policy.mode === "normal") return next();
			delayMs = localDelay(policy, retry, random);
		} else delayMs = failure.providerRetryAfterMs;
		else delayMs = localDelay(policy, retry, random);
		return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal);
	}

	const disposeListener = ctx.on("agent/request-error", (payload, next) => {
		if (lifetime.signal.aborted) return Promise.resolve(void 0);
		return track(recover(payload, next));
	});

	// ── A1(v0.3.3)：阀收尾自愈接力 ──
	// 阀收尾的轮必然以失败态结束（agent-loop 对 request-error 的非 retry 返回值一律抛 LlmError），
	// goal-round-driver 监听 agent/error 即解除 goal 自动续跑武装 → 任务停摆等人工。
	// 这里在轮空闲时把 active+disarmed 的 goal 重新 resume 武装：goal/change(resume) 反向触发
	// 驱动器排队下一轮，接力恢复无人值守。guard：无 goals 服务/无 goal/已 armed 一律跳过；
	// resume 抛错（含轮预算耗尽）只记日志，绝不打断主循环。
	ctx.on("agent/status", ({ agent, status }) => {
		try {
			if (status !== "idle" || !agent?.id) return;
			if (!valveRelayPending.delete(agent.id)) return;
			const goals = ctx.goals;
			if (!goals || typeof goals.get !== "function" || typeof goals.resume !== "function") return;
			const goal = goals.get(agent);
			if (!goal || goal.phase !== "active" || goal.activation === "armed") return;
			goals.resume(agent, { id: goal.id, revision: goal.revision });
			ctx.logger.warn(`llm-retry-escape: escape-valve turn ended — goal ${goal.id} re-armed, next round will be queued automatically`);
			appendInsight({
				source: "plugin",
				session: agent.session?.header?.id || "",
				workspace: agent.session?.header?.cwd || "",
				phenomenon: "relay-rearmed",
				detail: `阀收尾轮结束，已重新武装 goal ${goal.id}（rev ${goal.revision}）——下一轮自动接力`,
				resolved: "已修复接力断链",
				lesson: "止损的终点是接力，不是停摆——失败轮必须自愈 goal 武装状态",
			});
		} catch (error) {
			try {
				ctx.logger.warn(`llm-retry-escape: relay re-arm failed: ${error?.message || error}`);
			} catch {
				// 永不打断主循环
			}
		}
	});

	// ── B：turn 层磁盘进度哨兵（通用：自动监视会话工作区）──
	const progressState = /* @__PURE__ */ new Map(); // sessionId -> 状态
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		try {
			const sid = exec?.agent?.session?.header?.id;
			if (sid) {
				const st = progressState.get(sid);
				// v0.3.5：只认"可能落盘"的工具——纯读取/检索类不计入干活证据（修纯分析轮误报）
				const toolName = String(exec?.name || "");
				if (st && !READ_ONLY_TOOL_RE.test(toolName)) st.sawTools = true;
			}
		} catch {
			// 忽略
		}
		return next();
	});
	ctx.on("agent/pre-step", async ({ agent, turn }, next) => {
		let injectText = null;
		let injectStreak = 0;
		let strategyText = null;
		let strategyTag = "连败策略注入";
		try {
			if (agent?.session?.header?.origin === "subagent") return await next();
			const sid = agent.session.header.id;
			const watchDir = PROGRESS_WATCH_DIR_OVERRIDE || agent.session.header.cwd || process.cwd();
			let st = progressState.get(sid);
			if (!st) {
				st = { lastTurn: -1, startFp: "", zeroStreak: 0, sawTools: false, checkFailing: false, pendingCheckWarn: null, watchDir, resolvedLogged: new Set() };
				progressState.set(sid, st);
			}
			if (!st.resolvedLogged) st.resolvedLogged = new Set();
			logRetryResolutions(agent, st.resolvedLogged);   // C(v0.3.2)：解决即记账（此前带失败史且已完成的步骤记 retry-resolved）
			// A1-Coach(v0.3.4)：消费策略注入待办——上一轮的连败步，本轮入口给出生成形状指令
			const sp = strategyPending.get(agent.id);
			if (sp && sp.count >= STRATEGY_AFTER && STRATEGY_MAX_LEVEL > 0) {
				strategyPending.delete(agent.id);
				// v0.3.6：阶梯键=agentId（turn 每轮递增，按 (turn,step) 匹配永不上浮）；有历史注入且风暴仍在 → +1
				const prevLv = strategyLadder.get(agent.id);
				const level = prevLv ? Math.min(prevLv.level + 1, STRATEGY_MAX_LEVEL) : 1;
				strategyLadder.set(agent.id, { level, injectedTurn: typeof turn === "number" ? turn : -1 });
				const escalated = level >= 2;
				strategyText = escalated
					? strategyEscalateText(sp.count, sp.codes, sp.turn, sp.step)
					: strategyWarnText(sp.count, sp.codes, sp.turn, sp.step);
				strategyTag = escalated ? `连败策略升级(L${level})` : "连败策略注入";
				appendInsight({
					source: "plugin",
					session: sid,
					workspace: agent.session?.header?.cwd || "",
					phenomenon: escalated ? "strategy-escalated" : "strategy-injected",
					detail: escalated
						? `turn${sp.turn}/step${sp.step} 形状策略注入后仍连败 ${sp.count} 次（${sp.codes.join("/")}）——已升级「拆任务」指令（阶梯 L${level}）`
						: `turn${sp.turn}/step${sp.step} 连败 ${sp.count} 次（${sp.codes.join("/")}）——已注入生成形状策略（小块输出/分块落盘）`,
					resolved: escalated ? `已注入升级策略(L${level})` : "已注入策略",
					lesson: escalated ? "同一粒度反复失败=粒度病——先拆小再干活，或换实现路径" : "换新请求必须换生成形状——小块输出绕开中继杀手窗口",
				});
			} else if (sp) {
				strategyPending.delete(agent.id);   // 未达阈值的风暴记录：静默消费，不注入
			}
			// v0.3.6：风暴痊愈复位——本轮入口无待注入记录且已过注入轮 → 阶梯清零
			const ladNow = strategyLadder.get(agent.id);
			if (ladNow && !sp && typeof turn === "number" && turn > ladNow.injectedTurn) strategyLadder.delete(agent.id);
			if (typeof turn === "number" && turn !== st.lastTurn) {
				if (st.pendingCheckWarn) {
					// 校验门警告优先于 streak 警告（负进度比伪进度更毒）
					injectText = st.pendingCheckWarn;
					injectStreak = 0;
					st.pendingCheckWarn = null;
				} else if (st.zeroStreak > 0) {
					injectText = st.zeroStreak === 1 ? PROGRESS_WARN_1 : progressWarnN(st.zeroStreak);
					injectStreak = st.zeroStreak;
					appendInsight({
						source: "plugin",
						session: sid,
						workspace: st.watchDir,
						phenomenon: "pseudoprogress",
						detail: `连续 ${st.zeroStreak} 轮调用工具但工作区零落盘`,
						resolved: injectStreak === 1 ? "已注入警告" : `已注入升级警告(x${injectStreak})`,
						lesson: "承诺不落盘=伪进度——一切以磁盘文件为准",
					});
				}
				st.lastTurn = turn;
				st.sawTools = false;
				st.startFp = await fingerprintDir(st.watchDir, PROGRESS_EXCLUDES, PROGRESS_MAX_WALK);
			}
		} catch {
			// 哨兵永不破坏主循环
		}
		const decision = await next();
		try {
			const extras = [];
			if (injectText && decision?.kind === "enter") {
				const tag = injectStreak > 0 ? "磁盘零进展 x" + injectStreak : "校验未通过";
				extras.push(progressNotice(injectText, tag));
			}
			if (strategyText && decision?.kind === "enter") {
				extras.push(progressNotice(strategyText, strategyTag, "retry-strategy"));
			}
			if (extras.length > 0 && decision && decision.kind === "enter" && Array.isArray(decision.messages)) {
				return { ...decision, messages: [...decision.messages, ...extras] };
			}
		} catch {
			// 忽略
		}
		return decision;
	});
	ctx.on("agent/turn-stopping", async ({ agent }) => {
		try {
			if (!agent?.session?.header || agent.session.header.origin === "subagent") return;
			const sid = agent.session.header.id;
			const st = progressState.get(sid);
			if (!st || st.lastTurn < 0) return;
			if (!st.resolvedLogged) st.resolvedLogged = new Set();
			logRetryResolutions(agent, st.resolvedLogged);   // C(v0.3.2)：轮末兜底——最后一步的重试成功也记账
			const endFp = await fingerprintDir(st.watchDir, PROGRESS_EXCLUDES, PROGRESS_MAX_WALK);
			const changed = endFp !== st.startFp;
			// ── D：负进度/静默腐蚀校验门（工作区变化即校验，独立于 streak 追踪）──
			if (CHECK_CMD && changed) {
				const vr = await runCheckCmd(st.watchDir);
				if (!vr.ok) {
					st.checkFailing = true;
					st.pendingCheckWarn = CHECK_WARN_PREFIX + (vr.output || "（无输出）");
					appendInsight({
						source: "plugin",
						session: sid,
						workspace: st.watchDir,
						phenomenon: "regression",
						detail: `校验失败（exit ${vr.code}）：${vr.output || "无输出"}`,
						resolved: "已注入校验警告",
						lesson: "负进度/静默腐蚀——改动后必须过校验；校验写多深，防线就多深",
					});
				} else if (st.checkFailing) {
					st.checkFailing = false;
					appendInsight({
						source: "plugin",
						session: sid,
						workspace: st.watchDir,
						phenomenon: "regression-resolved",
						detail: "校验恢复通过",
						resolved: "已解决：回到绿",
						lesson: "破坏后修复并验证才算解决",
					});
				}
			}
			if (changed) {
				if (st.zeroStreak > 0) {
					appendInsight({
						source: "plugin",
						session: sid,
						workspace: st.watchDir,
						phenomenon: "pseudoprogress-resolved",
						detail: `${st.zeroStreak} 轮空转后出现真实落盘`,
						resolved: "已解决：磁盘状态前进",
						lesson: "回读确认的落盘才作数",
					});
				}
				st.zeroStreak = 0;
			} else if (st.sawTools) {
				st.zeroStreak += 1;   // 干了活但磁盘没动 = 伪进度嫌疑
			} else {
				st.zeroStreak = 0;    // 纯聊天轮：不惩罚
			}
			st.startFp = endFp;
		} catch {
			// 忽略
		}
	});

	// ── C：设置页洞察路由（仅 loopback）──
	let disposeRoute;
	ctx.effect(() => {
		try {
			if (ctx.webServer) disposeRoute = ctx.webServer.register(makeInsightsRoute());
		} catch {
			// 路由注册失败不影响重试本体
		}
		return async () => {
			disposeListener();
			if (disposeRoute) disposeRoute();
			lifetime.abort(new Error("dsh-llm-retry-escape plugin disposed"));
			progressState.clear();
			await Promise.allSettled([...active]);
		};
	}, "llm-retry-escape: abort, drain, insights route");
}

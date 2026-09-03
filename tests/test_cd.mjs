// test_cd.mjs — dsh-llm-retry-escape v0.3.1 功能 C/D 单元测试（mock，无真实 Host）
//   C 洞察账本路由：loopback 200 + 标记记录可读 / 非 loopback 403 / 坏行容错
//   D 校验门：DSH_PROGRESS_CHECK_CMD 失败 → 下一轮注入校验警告 + regression 账本；
//            恢复通过 → regression-resolved 账本 + 不再注入。
// 隔离方式：v0.3.1 起 insightsPath() 每次动态读 DSH_HOME——测试把 DSH_HOME 指到临时目录，
// 账本读写全程沙箱安全，且顺带验证动态化重构本身。真实账本的测试记录投递由外部投递步骤完成。
// 校验命令用哨兵文件翻转结果（存在→exit 0，不存在→exit 1），同一进程内完成失败/恢复两态。
// 运行：DSH Desktop.exe（ELECTRON_RUN_AS_NODE=1）tests/test_cd.mjs
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const watchDir = await fsp.mkdtemp(join(tmpdir(), "rl-cd-watch-"));
const ledgerHome = await fsp.mkdtemp(join(tmpdir(), "rl-cd-ledger-"));
const sentinel = join(watchDir, "check-pass.flag");

// 必须在插件加载前设置（模块读 env 定行为；DSH_HOME 决定账本位置）
process.env.DSH_PROGRESS_WATCH_DIR = watchDir;                                   // 哨兵监听覆盖
process.env.DSH_PROGRESS_CHECK_CMD = `if exist "%DSH_CD_SENTINEL%" (exit /b 0) else (exit /b 1)`;
process.env.DSH_PROGRESS_CHECK_TIMEOUT_MS = "15000";
process.env.DSH_CD_SENTINEL = sentinel;
process.env.DSH_HOME = ledgerHome;                                               // 账本 → 临时目录（沙箱安全）

const plugin = await import(new URL("../index.js", import.meta.url).href);

let pass = 0, fail = 0; const fails = [];
async function okA(name, fn) {
  try { await fn(); pass++; console.log("PASS " + name); }
  catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + (e && e.message || e)); }
}

function makeCtx() {
  const listeners = {}; const logs = [];
  return {
    listeners,
    logs,
    ctx: {
      on(event, handler) { (listeners[event] ||= []).push(handler); return () => {}; },
      effect(fn, label) { void fn; void label; },
      logger: { warn: (...a) => logs.push(a.map(String).join(" ")), debug: () => {}, info: () => {} },
    },
  };
}
function makeAgent(id) {
  const events = [];
  return { events, agent: { session: { header: { id, origin: "root" }, events, append: (t, d) => events.push({ type: t, data: d }) } } };
}

const { ctx, listeners } = makeCtx();
plugin.apply(ctx);
const onPreStep = listeners["agent/pre-step"][0];
const onTurnStopping = listeners["agent/turn-stopping"][0];
const onToolExecute = listeners["tools/post-execute"][0];
const enterNext = async () => ({ kind: "enter", messages: [] });
async function workTurn(agent, turn) {
  await onPreStep({ agent, turn }, enterNext);
  await onToolExecute({ agent }, null, async () => "ok");
}

// ── 账本直读辅助（动态路径：env.DSH_HOME 即临时账本）──
async function readLedger() {
  const file = plugin._internal.insightsPath();
  try {
    const raw = await fsp.readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { phenomenon: "unparsable" }; } });
  } catch { return []; }
}
// 动态路径必须落在 DSH_HOME（否则动态化重构回归）
await okA("C0 insightsPath() follows DSH_HOME dynamically", async () => {
  assert.ok(plugin._internal.insightsPath().startsWith(ledgerHome), "path under DSH_HOME");
});

// ═══ C：洞察账本路由 ═══
const route = plugin._internal.makeInsightsRoute();
function callRoute(addr) {
  return new Promise((resolve, reject) => {
    const cap = { code: null, body: "" };
    const req = { socket: { remoteAddress: addr } };
    const res = {
      writeHead(c) { cap.code = c; },
      end(b) { cap.body = String(b || ""); resolve(cap); },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

await okA("C1 route loopback 200 + marker readable end-to-end", async () => {
  plugin._internal.appendInsight({
    source: "test-suite", session: "tests/test_cd.mjs", workspace: watchDir,
    phenomenon: "test", detail: "C1 路由端到端标记记录", resolved: "已写入账本，待路由读回",
    lesson: "账本-路由-面板链路验证",
  });
  const cap = await callRoute("127.0.0.1");
  assert.equal(cap.code, 200);
  const j = JSON.parse(cap.body);
  assert.equal(j.ok, true);
  assert.ok(j.count >= 1, "count >= 1, got " + j.count);
  const marker = (j.records || []).find((r) => r.phenomenon === "test" && String(r.detail).includes("C1 路由端到端标记记录"));
  assert.ok(marker, "marker record visible via route");
});

await okA("C2 route non-loopback 403", async () => {
  const cap = await callRoute("192.0.2.77");
  assert.equal(cap.code, 403);
  const j = JSON.parse(cap.body);
  assert.equal(j.ok, false);
});

await okA("C3 unparsable ledger line tolerated", async () => {
  const ledgerFile = plugin._internal.insightsPath();
  await fsp.appendFile(ledgerFile, "{this-is-not-json\n", "utf8");
  const cap = await callRoute("127.0.0.1");
  assert.equal(cap.code, 200, "route still 200 with garbage line");
  const j = JSON.parse(cap.body);
  const un = (j.records || []).find((x) => x.phenomenon === "unparsable");
  assert.ok(un, "garbage mapped to unparsable record");
  const good = (j.records || []).find((x) => x.phenomenon === "test");
  assert.ok(good, "good records survive");
});

// ═══ D：负进度/静默腐蚀校验门 ═══
await okA("D1 check fail -> regression insight + warning injected next turn", async () => {
  const { agent } = makeAgent("d1");
  await workTurn(agent, 1);                                          // 干活
  await fsp.writeFile(join(watchDir, "d1-artifact.txt"), "v1");      // 落盘（哨兵不存在 → 校验必败）
  await onTurnStopping({ agent });                                   // changed → 校验运行 → 失败
  const ledger = await readLedger();
  const reg = [...ledger].reverse().find((r) => r.phenomenon === "regression" && r.session === "d1");
  assert.ok(reg, "regression insight appended");
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 1, "check warning injected");
  assert.equal(d2.messages[0].source.form, "progress-warning");
  assert.ok(d2.messages[0].content[0].text.includes("未通过校验"), "warning text mentions validation failure");
});

await okA("D2 check recovers -> regression-resolved + no more injection", async () => {
  const { agent } = makeAgent("d2");                                 // d2 与 d1 独立会话；先复现失败态
  await workTurn(agent, 1);
  await fsp.writeFile(join(watchDir, "d2-artifact.txt"), "v1");      // 真实 exec（受限环境 EPERM → 按失败处理）
  await onTurnStopping({ agent });
  const d2 = await onPreStep({ agent, turn: 2 }, enterNext);
  assert.equal(d2.messages.length, 1, "warning injected after failure");
  // 恢复态：受限环境 exec 永远无法成功，注入模拟执行器让校验转绿（簿记逻辑与真实 Host 同一路径）
  plugin._internal.__setCheckRunner(() => Promise.resolve({ ok: true, code: 0, output: "simulated-pass" }));
  try {
    await workTurn(agent, 2);
    await fsp.writeFile(join(watchDir, "d2-artifact.txt"), "v2");    // 变化 → 校验通过 → resolved
    await onTurnStopping({ agent });
  } finally {
    plugin._internal.__setCheckRunner(null);                         // 还原真实 exec
  }
  const ledger = await readLedger();
  const resolved = [...ledger].reverse().find((r) => r.phenomenon === "regression-resolved" && r.session === "d2");
  assert.ok(resolved, "regression-resolved insight appended");
  const d3 = await onPreStep({ agent, turn: 3 }, enterNext);
  assert.equal(d3.messages.length, 0, "no check warning when validation green");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));

// v0.3.1：测试结果写临时账本（沙箱内自检通过）；面板投递由外部投递步骤写入真实账本
try {
  plugin._internal.appendInsight({
    source: "test-suite",
    session: "tests/test_cd.mjs",
    workspace: process.cwd(),
    phenomenon: "test",
    detail: `test_cd v0.3.1: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}`,
    resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
    lesson: "C 路由 + D 校验门覆盖；动态 DSH_HOME 账本隔离验证",
  });
} catch { /* 账本失败不影响测试退出码 */ }

process.exit(fail ? 1 : 0);

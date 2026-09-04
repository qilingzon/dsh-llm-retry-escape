// test_v036b_housekeeping.mjs — v0.3.7 账本治理单元测试（mock req/res，无真实 Host）
// 验证：/insights limit 截断（?limit=N 可调 + 默认 500 + total 返回）、账本大小轮转（归档+续写）、
//       monitor-multi 日志 7 天保留（子进程真跑，临时 LOG_DIR/ROOTS/STATE 隔离）。
// 运行：node tests/test_v036b_housekeeping.mjs
import assert from "node:assert/strict";
import { promises as fsp, existsSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await fsp.mkdtemp(join(tmpdir(), "rl-house-home-"));
process.env.DSH_HOME = tempHome;
process.env.DSH_PROGRESS_WATCH_DIR = await fsp.mkdtemp(join(tmpdir(), "rl-house-watch-"));
delete process.env.DSH_RETRY_LEDGER_MAX_BYTES;

const plugin = await import(new URL("../dsh-llm-retry-escape/index.js", import.meta.url).href);

let pass = 0, fail = 0; const fails = [];
async function okA(name, fn) { try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; fails.push(name); console.log("FAIL " + name + " -> " + e.message); } }

function makeRes() {
  return { code: 0, body: "", writeHead(c) { this.code = c; }, end(s) { this.body = s; } };
}
async function callInsights(url) {
  const route = plugin._internal.makeInsightsRoute();
  const res = makeRes();
  await route.handler({ url, socket: { remoteAddress: "127.0.0.1" } }, res);
  return JSON.parse(res.body);
}
const rec = (n) => ({ source: "test-suite", session: "t", workspace: "w", phenomenon: "test", detail: "rec " + n, resolved: "r", lesson: "l" });
// T1 limit=2：count=2 / total=7 / 最新优先
await okA("insights ?limit=2 returns newest 2 with total", async () => {
  for (let i = 1; i <= 7; i++) plugin._internal.appendInsight(rec(i));
  const j = await callInsights("/api/dsh-llm-retry-escape/insights?limit=2");
  assert.equal(j.ok, true);
  assert.equal(j.count, 2);
  assert.equal(j.total, 7);
  assert.equal(j.limit, 2);
  assert.ok(j.records[0].detail.includes("rec 7"), "newest first");
  assert.ok(j.records[1].detail.includes("rec 6"), "second newest");
});

// T2 默认 limit=500（无 query）
await okA("insights default limit 500", async () => {
  for (let i = 8; i <= 510; i++) plugin._internal.appendInsight(rec(i));
  const j = await callInsights("/api/dsh-llm-retry-escape/insights");
  assert.equal(j.count, 500);
  assert.equal(j.total, 510);
  assert.equal(j.limit, 500);
});

// T3 轮转：MAX=1（动态 env）第二次追加触发归档 + 主文件续写
await okA("ledger rotation archives on overflow and keeps appending", async () => {
  const home2 = await fsp.mkdtemp(join(tmpdir(), "rl-house-rot-"));
  process.env.DSH_HOME = home2;
  process.env.DSH_RETRY_LEDGER_MAX_BYTES = "1";
  plugin._internal.appendInsight(rec("a"));   // 首条：文件不存在 → 不轮转
  plugin._internal.appendInsight(rec("b"));   // 二条：超限 → 归档 + 续写
  const files = readdirSync(home2).filter((f) => f.startsWith("retry-insights"));
  const archives = files.filter((f) => f.includes("-archive-"));
  assert.equal(archives.length, 1, "one archive created");
  const main = readFileSync(join(home2, "retry-insights.jsonl"), "utf8").trim().split("\n");
  assert.equal(main.length, 1, "main file restarted");
  assert.ok(main[0].includes("rec b"), "newest record in main");
  const archived = readFileSync(join(home2, archives[0]), "utf8").trim().split("\n");
  assert.equal(archived.length, 1, "old record archived");
  assert.ok(archived[0].includes("rec a"), "archived content preserved");
  delete process.env.DSH_RETRY_LEDGER_MAX_BYTES;
  process.env.DSH_HOME = tempHome;
});

// T4 monitor-multi 日志 7 天保留（子进程真跑：临时 LOG_DIR/ROOTS/STATE 全隔离）
await okA("monitor log retention deletes >7d logs at startup (subprocess)", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const logDir = await fsp.mkdtemp(join(tmpdir(), "rl-house-logs-"));
  const roots = await fsp.mkdtemp(join(tmpdir(), "rl-house-roots-"));
  const state = join(logDir, "state.json");
  const old = join(logDir, "monitor-multi-20260101.log");
  writeFileSync(old, "old log\n");
  const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(old, oldTime, oldTime);
  const monPath = fileURLToPath(new URL("../out/monitor-multi.cjs", import.meta.url));
  await promisify(execFile)(process.execPath, [monPath, roots, state], {
    env: { ...process.env, DSH_MONITOR_LOG_DIR: logDir, DSH_MONITOR_ROOTS: roots, DSH_MONITOR_MAX_MIN: "0.03", DSH_MONITOR_POLL_MS: "1000" },
    timeout: 60000,
  });
  assert.ok(!existsSync(old), "old log deleted");
  const left = readdirSync(logDir).filter((f) => /^monitor-multi-\d{8}\.log$/.test(f));
  assert.equal(left.length, 1, "new log created");
});

console.log(`RESULT pass=${pass} fail=${fail}`);
if (fails.length) console.log("FAILED: " + fails.join(" | "));
process.env.DSH_HOME = "";
try {
  plugin._internal.appendInsight({
    source: "test-suite", session: "tests/test_v036b_housekeeping.mjs", workspace: process.cwd(), phenomenon: "test",
    detail: `test_v036b v0.3.7: pass=${pass} fail=${fail}${fails.length ? "（挂：" + fails.join("；") + "）" : ""}（insights limit/total + 账本轮转 + 监视器日志保留 7 天）`,
    resolved: fail === 0 ? "全部通过" : `存在失败 ${fail} 项`,
    lesson: "观测数据也要治理——limit/轮转/保留期三件套",
  });
} catch { /* 不影响退出码 */ }
process.exit(fail ? 1 : 0);

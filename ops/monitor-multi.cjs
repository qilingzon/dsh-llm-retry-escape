// monitor-multi.cjs — 多会话聚合监视器（v0.3.6 队列②）：同时盯多个会话根目录各自的最新会话
// 每根独立风暴状态机 + 阀后接力等待（不阻塞其他根巡视）；共享洞察账本去重记账（启动基线后只记增量）；
// 任一根抓到完整战役（battle-won 或 阀+接力判定）即写状态并退出（exit 0 = 有战报，重启续盯）。
// 用法：node monitor-multi.cjs [rootsCsv] [stateFile]
//   rootsCsv 缺省 = armor-lab + web1；环境变量 DSH_MONITOR_ROOTS 优先
//   调参：DSH_MONITOR_POLL_MS（默认 20000）、DSH_MONITOR_MAX_MIN（默认 240）
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const HOME = "C:/Users/qiling/.dsh/sessions";
const ROOTS = (process.env.DSH_MONITOR_ROOTS || process.argv[2] ||
  [HOME + "/--D-deepseek-armor-lab--", HOME + "/--D-deepseek-web1--"].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
const LEDGER = "C:/Users/qiling/.dsh/retry-insights.jsonl";
const LOG = path.join(__dirname, "monitor-multi-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".log");
const POLL_MS = Number(process.env.DSH_MONITOR_POLL_MS) || 20000;
const MAX_MIN = Number(process.env.DSH_MONITOR_MAX_MIN) || 240;
const STATE_FILE = process.argv[3] || path.join(__dirname, "monitor-multi.state.json");
const START = Date.now();
const fmt = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const TAG = (root) => path.basename(root).replace(/^--D-deepseek-/, "").replace(/--$/, "");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function log(line) { try { fs.appendFileSync(LOG, "[" + fmt(Date.now()) + "] " + line + "\n"); } catch { /* 日志失败永不影响监视 */ } }
function newestSession(root) {
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith("session-"));
  let best = null;
  for (const d of dirs) {
    const f = path.join(root, d, "session.jsonl.zstd");
    try { const m = fs.statSync(f).mtimeMs; if (!best || m > best.mtime) best = { d, mtime: m }; } catch {}
  }
  return best;
}
function decode(f) {
  const buf = fs.readFileSync(f);
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const offs = [];
  for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) offs.push(i);
  let out = Buffer.alloc(0);
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out = Buffer.concat([out, zlib.zstdDecompressSync(buf.subarray(offs[k], end))]); } catch {}
  }
  const ev = [];
  for (const line of out.toString("utf8").split("\n")) { try { ev.push(JSON.parse(line)); } catch {} }
  return ev;
}
function ledgerLines() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
let ledgerSeen = ledgerLines().length;   // 启动基线：历史记录不再重放，只记增量（防重启刷屏）
const stateMap = {};   // tag -> {key, lastFail} 已报告风暴，重启后跳过
try { Object.assign(stateMap, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
const watchers = ROOTS.map((root) => ({ root, tag: TAG(root), lastSeq: -1, storm: null, relayWait: null, lastResolved: null }));
function exitReport(code) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(stateMap)); } catch {} process.exit(code); }
log("monitor-multi start: roots=[" + watchers.map((w) => w.tag).join(", ") + "], ledger baseline=" + ledgerSeen + ", horizon " + MAX_MIN + "min, poll " + POLL_MS + "ms");

function watchOne(w) {
  // 阀后接力等待态：不阻塞其他根的巡视，每 tick 查一次新 turn
  if (w.relayWait) {
    const s = newestSession(w.root);
    if (s) {
      const ev = decode(path.join(w.root, s.d, "session.jsonl.zstd"));
      const nt = ev.find((e) => e.type === "turn/start" && (e.time || 0) > w.relayWait.turnEndTime && (e.data?.turn ?? 0) > w.relayWait.turn);
      if (nt) {
        log("[" + w.tag + "] RELAY-OK: goal auto-continued -> turn" + (nt.data?.turn ?? "?") + " (" + Math.round((nt.time - w.relayWait.turnEndTime) / 60000) + "min after valve)");
        return "full-correction-cycle";
      }
    }
    if (Date.now() > w.relayWait.deadline) return "valve-no-relay(15min)";
    return false;
  }
  const s = newestSession(w.root);
  if (!s) { log("[" + w.tag + "] no session dir found"); return false; }
  const ev = decode(path.join(w.root, s.d, "session.jsonl.zstd"));
  const maxSeq = Math.max(...ev.filter((e) => e.seq !== undefined).map((e) => e.seq), 0);
  if (maxSeq === w.lastSeq) return false;
  w.lastSeq = maxSeq;
  const retries = ev.filter((e) => e.type === "llm/retry");
  if (retries.length === 0) return false;
  const lastR = retries[retries.length - 1];
  if (Date.now() - lastR.time > 10 * 60000) {
    // 无活跃风暴；armor-lab 根保留 gen4 落盘进度快照
    if (w.tag === "armor-lab" && maxSeq % 1500 < 20) {
      try {
        const plug = "D:/deepseek/armor-lab/gen4-lab/gen4_home/plugins/dsh-infinite-gen-4";
        const files = fs.readdirSync(plug, { recursive: true }).filter((f) => fs.statSync(path.join(plug, f)).isFile());
        const total = files.reduce((a, f) => a + fs.statSync(path.join(plug, f)).size, 0);
        log("[armor-lab] disk-snapshot: gen4 files=" + files.length + " bytes=" + total + " [" + files.join(", ").slice(0, 120) + "]");
      } catch { log("[armor-lab] disk-snapshot: gen4 dir not yet created"); }
    }
    return false;
  }
  const key = lastR.data.turn + "/" + lastR.data.step;
  // 已解决的风暴不因新事件到达而重报（最后 retry 事件在 10 分钟窗口内保持不变，防止刷屏）
  if (!w.storm && w.lastResolved && w.lastResolved.key === key && w.lastResolved.lastFail === lastR.time) return false;
  if (!w.storm || w.storm.key !== key) {
    const first = retries.find((r) => r.data.turn + "/" + r.data.step === key);
    w.storm = { key, turn: lastR.data.turn, step: lastR.data.step, firstFail: first.time, fails: retries.filter((r) => r.data.turn + "/" + r.data.step === key).length, lastFail: lastR.time };
    log("[" + w.tag + "] STORM-START: turn" + w.storm.turn + "/step" + w.storm.step + " @" + fmt(w.storm.firstFail));
  }
  if (lastR.time > w.storm.lastFail) {
    w.storm.fails += 1;
    w.storm.lastFail = lastR.time;
    log("[" + w.tag + "]   fail #" + w.storm.fails + " @" + fmt(lastR.time) + " " + (lastR.data.failure?.code || "?") + " delay=" + Math.round(lastR.data.delayMs) + "ms" + (lastR.data.delayMs > 5000 ? "  << A2 CAP VIOLATION" : lastR.data.delayMs >= 5000 ? " (5s cap)" : ""));
  }
  // 解决判定 A：恢复（同轮失败后真正走起来）
  const after = ev.filter((e) => (e.time || 0) > w.storm.lastFail && ["assistant/message", "tool/call"].includes(e.type) && e.data?.turn === w.storm.turn);
  if (after.length > 0) {
    const dur = Math.round((after[0].time - w.storm.firstFail) / 1000);
    log("[" + w.tag + "] BATTLE-WON: turn" + w.storm.turn + "/step" + w.storm.step + " recovered @" + fmt(after[0].time) + " (" + after[0].type + "); fails=" + w.storm.fails + " storm=" + dur + "s");
    if (w.storm.fails >= 2) {
      const rep = stateMap[w.tag];
      if (!(rep && rep.key === w.storm.key && rep.lastFail === w.storm.lastFail)) {
        stateMap[w.tag] = { key: w.storm.key, lastFail: w.storm.lastFail };
        w.lastResolved = { key: w.storm.key, lastFail: w.storm.lastFail };
        w.storm = null;
        return "battle-won";
      }
    }
    w.lastResolved = { key: w.storm.key, lastFail: w.storm.lastFail };
    w.storm = null;   // 单败小嗝：记账后继续值守
    return false;
  }
  // 解决判定 B：5 阀触发（turn 结束）→ 进入接力等待态（不阻塞其他根）
  const turnEnd = [...ev].reverse().find((e) => e.type === "turn/end" && (e.data?.turn === w.storm.turn || e.data?.turn === undefined));
  if (turnEnd && turnEnd.time > w.storm.lastFail && w.storm.fails >= 5) {
    log("[" + w.tag + "] VALVE-FIRED: turn" + w.storm.turn + " ended @" + fmt(turnEnd.time) + " after " + w.storm.fails + " fails (" + Math.round((turnEnd.time - w.storm.firstFail) / 1000) + "s)");
    w.relayWait = { turn: w.storm.turn, turnEndTime: turnEnd.time, deadline: Date.now() + 15 * 60000 };
    w.storm = null;
  }
  return false;
}

while (Date.now() - START < MAX_MIN * 60000) {
  try {
    const ledger = ledgerLines();
    if (ledger.length > ledgerSeen) {
      for (const r of ledger.slice(ledgerSeen)) log("ledger+: " + r.ts + " " + r.source + " " + r.phenomenon + " | " + String(r.detail).slice(0, 90));
      ledgerSeen = ledger.length;
    }
    for (const w of watchers) {
      const verdict = watchOne(w);
      if (verdict) { log("MONITOR-EXIT: " + verdict + " [" + w.tag + "]"); exitReport(0); }
    }
  } catch (err) { log("poll error: " + err.message); }
  wait(POLL_MS);
}
log("MONITOR-EXIT: horizon reached (no battle)");
exitReport(0);

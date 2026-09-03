// monitor-armor3.cjs — 全战役监视器（会话事件流 → 风暴状态机 → 洞察账本增量 → 磁盘快照）
// 用法：node monitor-armor3.cjs [sessionsRoot] [ledgerFile] [logFile]
//   sessionsRoot : DSH 会话根目录，默认 %DSH_HOME%\sessions（或 %USERPROFILE%\.dsh\sessions）
//                  监视其中【最近写入】的会话（递归 workspace/session-*/session.jsonl.zstd）
//   ledgerFile   : 洞察账本路径，默认 %DSH_HOME%\retry-insights.jsonl
//   logFile      : 监视日志输出路径，默认脚本同目录 monitor.log
// 行为：每 20s 解码最新会话事件流；≥2 败的战役结束或「5 阀 + 接力」全周期时退出报告；
//       单败小嗝只记账；每约 1500 个 seq 记一次可选磁盘快照（MONITOR_SNAPSHOT_DIR 可配）。
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const USER_DSH = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const ROOT = process.argv[2] || path.join(USER_DSH, "sessions");
const LEDGER = process.argv[3] || path.join(USER_DSH, "retry-insights.jsonl");
const LOG = process.argv[4] || path.join(__dirname, "monitor.log");
const SNAP_DIR = process.env.MONITOR_SNAPSHOT_DIR || "";   // 可选：落盘进度快照目录
const POLL_MS = 20000;
const MAX_MINUTES = 240;
const STATE = process.argv[5] || (process.argv[4] ? process.argv[4] + ".state" : path.join(__dirname, "monitor.state.json"));
// STATE file: remembers the last reported storm so relaunches skip it
// STATE file: remembers the last reported storm so relaunches skip it
const fmt = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

function log(line) { fs.appendFileSync(LOG, `[${fmt(Date.now())}] ${line}\n`); }

// sessions/<workspace>/<session-uuid>/session.jsonl.zstd —— 取最近写入者
function newestSession() {
  let best = null;
  let workspaces = [];
  try { workspaces = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  for (const w of workspaces) {
    const wdir = path.join(ROOT, w);
    let subs = [];
    try { subs = fs.readdirSync(wdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const d of subs) {
      const f = path.join(wdir, d, "session.jsonl.zstd");
      try { const m = fs.statSync(f).mtimeMs; if (!best || m > best.mtime) best = { root: wdir, d, mtime: m }; } catch {}
    }
  }
  return best;
}
function decode(f) {
  const buf = fs.readFileSync(f);
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);   // zstd frame magic
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
function diskSnapshot() {
  if (!SNAP_DIR) return;
  try {
    const files = fs.readdirSync(SNAP_DIR, { recursive: true }).filter((f) => fs.statSync(path.join(SNAP_DIR, f)).isFile());
    const total = files.reduce((a, f) => a + fs.statSync(path.join(SNAP_DIR, f)).size, 0);
    log(`disk-snapshot: files=${files.length} bytes=${total} [${files.join(", ").slice(0, 120)}]`);
  } catch { log("disk-snapshot: snapshot dir not yet created"); }
}

let lastSeq = -1;
let lastReported = null;
try { lastReported = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
// STATE file: remembers the last reported storm so relaunches skip it
let ledgerSeen = 0;
let activeStorm = null; // {key, turn, step, firstFail, fails, lastFail}
log(`monitor start: root=${ROOT}; horizon=${MAX_MINUTES}min; poll=${POLL_MS}ms`);

while (Date.now() - START < MAX_MINUTES * 60000) {
  try {
    const s = newestSession();
    if (!s) { log("no session dir found"); continue; }
    const ev = decode(path.join(s.root, s.d, "session.jsonl.zstd"));
    const maxSeq = Math.max(...ev.filter((e) => e.seq !== undefined).map((e) => e.seq), 0);
    if (maxSeq === lastSeq) { /* 静默 */ }
    else {
      lastSeq = maxSeq;
      const retries = ev.filter((e) => e.type === "llm/retry");
      // 账本增量
      const ledger = ledgerLines();
      if (ledger.length > ledgerSeen) {
        for (const r of ledger.slice(ledgerSeen)) log(`ledger+: ${r.ts} ${r.source} ${r.phenomenon} | ${String(r.detail).slice(0, 90)}`);
        ledgerSeen = ledger.length;
      }
      // 风暴状态机（只认 10 分钟内的失败——历史风暴不重判）
      if (retries.length > 0) {
        const lastR = retries[retries.length - 1];
        if (Date.now() - lastR.time > 10 * 60000) {
          // 无活跃风暴；周期性磁盘快照
          if (maxSeq % 1500 < 20) diskSnapshot();
        } else {
        const key = `${lastR.data.turn}/${lastR.data.step}`;
        if (!activeStorm || activeStorm.key !== key) {
          const first = retries.find((r) => `${r.data.turn}/${r.data.step}` === key);
          activeStorm = { key, turn: lastR.data.turn, step: lastR.data.step, firstFail: first.time, fails: retries.filter((r) => `${r.data.turn}/${r.data.step}` === key).length, lastFail: lastR.time };
          log(`STORM-START: turn${activeStorm.turn}/step${activeStorm.step} @${fmt(activeStorm.firstFail)}`);
        }
        if (lastR.time > activeStorm.lastFail) {
          activeStorm.fails += 1;
          activeStorm.lastFail = lastR.time;
          log(`  fail #${activeStorm.fails} @${fmt(lastR.time)} ${lastR.data.failure?.code} delay=${Math.round(lastR.data.delayMs)}ms${lastR.data.delayMs > 5000 ? "  << CAP VIOLATION" : lastR.data.delayMs >= 5000 ? " (cap)" : ""}`);
        }
        // 解决判定 A：恢复（同轮失败后真正走起来）
        const after = ev.filter((e) => (e.time || 0) > activeStorm.lastFail && ["assistant/message", "tool/call"].includes(e.type) && e.data?.turn === activeStorm.turn);
        if (after.length > 0) {
          const dur = Math.round((after[0].time - activeStorm.firstFail) / 1000);
          const resolved = ledger.filter((l) => l.phenomenon === "retry-resolved" && String(l.detail).includes(`turn${activeStorm.turn}/step${activeStorm.step}`) && new Date(l.ts).getTime() > activeStorm.firstFail - 86400000);
          log(`BATTLE-WON: turn${activeStorm.turn}/step${activeStorm.step} recovered @${fmt(after[0].time)} (${after[0].type}); fails=${activeStorm.fails} storm=${dur}s; ledger-resolved-record=${resolved.length > 0 ? "YES" : "pending(next pre-step)"}`);
          if (activeStorm.fails >= 2) {
            if (lastReported && lastReported.key === activeStorm.key && lastReported.lastFail === activeStorm.lastFail) { activeStorm = null; }
            else { try { fs.writeFileSync(STATE, JSON.stringify({ key: activeStorm.key, lastFail: activeStorm.lastFail })); } catch {}
            log("MONITOR-EXIT: battle-won");
            process.exit(0); }
          }
          activeStorm = null;   // 单败小嗝：记账后继续值守
        }
        // 解决判定 B：逃生阀触发（turn 结束 + 账本 deadloop）
        const turnEnd = activeStorm ? [...ev].reverse().find((e) => e.type === "turn/end" && (e.data?.turn === activeStorm.turn || e.data?.turn === undefined)) : null;
        if (turnEnd && turnEnd.time > activeStorm.lastFail && activeStorm.fails >= 5) {
          const dead = ledger.filter((l) => l.phenomenon === "deadloop" && String(l.detail).includes(`turn${activeStorm.turn}`));
          log(`VALVE-FIRED: turn${activeStorm.turn} ended @${fmt(turnEnd.time)} after ${activeStorm.fails} fails (${Math.round((turnEnd.time - activeStorm.firstFail) / 1000)}s); deadloop-record=${dead.length ? dead[dead.length - 1].detail : "MISSING!"}`);
          // 等接力：15 分钟内出现新 turn/start
          const deadline = Date.now() + 15 * 60000;
          let relayed = false;
          while (Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
            const ev2 = decode(path.join(s.root, s.d, "session.jsonl.zstd"));
            const newTurn = ev2.find((e) => e.type === "turn/start" && (e.time || 0) > turnEnd.time && (e.data?.turn ?? 0) > activeStorm.turn);
            if (newTurn) {
              log(`RELAY-OK: goal auto-continued -> turn${newTurn.data?.turn ?? "?"} @${fmt(newTurn.time)} (${Math.round((newTurn.time - turnEnd.time) / 60000)}min after valve)`);
              relayed = true;
              break;
            }
          }
          log(relayed ? "MONITOR-EXIT: full-correction-cycle" : "MONITOR-EXIT: valve-no-relay(15min)");
          process.exit(0);
        }
        }
      }
    }
  } catch (err) {
    log(`poll error: ${err.message}`);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
}
log("MONITOR-EXIT: horizon reached (no battle)");

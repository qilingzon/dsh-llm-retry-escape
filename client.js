/* dsh-llm-retry-escape client half — 设置页「反卡死历史」面板 + 输入区状态徽标
 * 面板：轮询 /api/dsh-llm-retry-escape/insights，按时间倒序渲染五类病理事件
 *   （死循环/活锁/伪进度/负进度/静默腐蚀）的时间、会话、工作区、详情、状态与经验。
 *   v0.3.1 起同为测试套件记录（phenomenon=test，蓝色 🧪 标签）的展示位。
 * 徽标：沿用会话投影；本插件不注册投影，仅保留设置页。
 */
window.__ModuleLoader__.load({
  id: "dsh-llm-retry-escape",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    var inject = ["slots"];

    var PHEN_LABEL = {
      "deadloop": "死循环·重连耗尽",
      "pseudoprogress": "伪进度/活锁",
      "pseudoprogress-resolved": "✅ 伪进度解除",
      "regression": "负进度/静默腐蚀·校验失败",
      "regression-resolved": "✅ 校验恢复通过",
      "relay-timeout": "超时止损",
      "relay-livelock": "活锁止损",
      "relay-zeroprogress": "伪进度止损",
      "relay-regression": "负进度·已回滚",
      "test": "🧪 测试套件",
      "retry-detected": "重试·发现失败",
      "retry-resolved": "✅ 重试成功·已解决",
      "relay-rearmed": "🔁 阀后自动接力",
      "strategy-injected": "📜 连败策略注入",
      "strategy-escalated": "📜 升级·拆任务",
      "config-disease": "⚙️ 配置病诊断",
      "unparsable": "无法解析的记录"
    };
    var PHEN_COLOR = {
      "deadloop": "#ef4444",
      "pseudoprogress": "#f59e0b",
      "pseudoprogress-resolved": "#22c55e",
      "regression": "#ef4444",
      "regression-resolved": "#22c55e",
      "relay-timeout": "#f59e0b",
      "relay-livelock": "#f59e0b",
      "relay-zeroprogress": "#f59e0b",
      "relay-regression": "#ef4444",
      "test": "#3b82f6",
      "retry-detected": "#f59e0b",
      "retry-resolved": "#22c55e",
      "relay-rearmed": "#06b6d4",
      "strategy-injected": "#8b5cf6",
      "strategy-escalated": "#d946ef",
      "config-disease": "#f97316",
      "unparsable": "#9ca3af"
    };

    function fmtTime(iso) {
      try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso || "?"); }
    }
    function shortSession(s) {
      var str = String(s || "");
      return str.length > 18 ? str.slice(0, 18) + "…" : str;
    }

    var TABLE_STYLE = {
      width: "100%", borderCollapse: "collapse", fontSize: "12px", lineHeight: "18px"
    };
    var TH_STYLE = {
      textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-label-caption, #888)",
      color: "var(--dsw-alias-label-secondary, #888)", fontWeight: 600, whiteSpace: "nowrap"
    };
    var TD_STYLE = {
      padding: "4px 8px", borderBottom: "1px solid rgba(128,128,128,.15)",
      verticalAlign: "top", wordBreak: "break-all"
    };

    function InsightsCard() {
      var statePair = react.useState({ ok: true, records: [], count: 0 });
      var data = statePair[0];
      var setData = statePair[1];
      var errPair = react.useState("");
      var errorText = errPair[0];
      var setErr = errPair[1];

      react.useEffect(function () {
        var stopped = false;
        var tick = function () {
          fetch("/api/dsh-llm-retry-escape/insights", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (!stopped) { setData(j); setErr(""); } })
            .catch(function (e) { if (!stopped) setErr(String(e && e.message || e)); });
        };
        tick();
        var timer = setInterval(tick, 5000);
        return function () { stopped = true; clearInterval(timer); };
      }, []);

      var records = Array.isArray(data.records) ? data.records : [];

      // v0.3.6 ④：统计卡——按现象聚合当前加载的记录，色点计数条（未知现象也兜底显示）
      var PHEN_ORDER = ["retry-detected", "retry-resolved", "strategy-injected", "strategy-escalated", "config-disease", "deadloop", "pseudoprogress", "pseudoprogress-resolved", "regression", "regression-resolved", "relay-timeout", "relay-livelock", "relay-zeroprogress", "relay-regression", "relay-rearmed", "test"];
      var stats = {};
      records.forEach(function (r) { var k = String(r.phenomenon || "unparsable"); stats[k] = (stats[k] || 0) + 1; });
      var statKeys = PHEN_ORDER.filter(function (k) { return stats[k]; }).concat(
        Object.keys(stats).filter(function (k) { return PHEN_ORDER.indexOf(k) === -1; }).sort()
      );
      var statsStrip = records.length === 0 ? null : react.createElement("div",
        { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" } },
        statKeys.map(function (k) {
          var color = PHEN_COLOR[k] || "#9ca3af";
          return react.createElement("span", { key: k,
            style: { fontSize: "11px", padding: "2px 8px", borderRadius: "10px", border: "1px solid " + color + "66", color: color, whiteSpace: "nowrap", background: color + "14" } },
            (PHEN_LABEL[k] || k) + " × " + stats[k]);
        })
      );

      var headline = react.createElement("div", { style: { marginBottom: "8px", display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
        react.createElement("span", { style: { fontWeight: 600 } }, "五种病理监测历史"),
        react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)" } },
          "死循环 / 活锁 / 伪进度 / 负进度 / 静默腐蚀 · " + (typeof data.total === "number" && data.total > records.length ? "最近 " + records.length + " / 共 " + data.total + " 条" : "共 " + records.length + " 条") + " · 5s 自动刷新"),
        errorText ? react.createElement("span", { style: { fontSize: "11px", color: "#ef4444" } }, "读取失败：" + errorText) : null
      );

      var header = react.createElement("tr", null,
        ["时间", "现象", "会话", "工作区", "详情", "状态 / 经验"].map(function (h, i) {
          return react.createElement("th", { key: i, style: TH_STYLE }, h);
        })
      );

      var rows = records.map(function (r, i) {
        var phen = PHEN_LABEL[r.phenomenon] || r.phenomenon;
        var color = PHEN_COLOR[r.phenomenon] || "#9ca3af";
        return react.createElement("tr", { key: i },
          react.createElement("td", { style: TD_STYLE, whiteSpace: "nowrap" }, fmtTime(r.ts)),
          react.createElement("td", { style: TD_STYLE, whiteSpace: "nowrap" },
            react.createElement("span", { style: { color: color, fontWeight: 600 } }, phen)),
          react.createElement("td", { style: TD_STYLE }, shortSession(r.session)),
          react.createElement("td", { style: TD_STYLE, wordBreak: "break-all" }, String(r.workspace || "")),
          react.createElement("td", { style: TD_STYLE }, String(r.detail || "")),
          react.createElement("td", { style: TD_STYLE },
            react.createElement("div", null, String(r.resolved || "")),
            r.lesson ? react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "11px" } }, "经验：" + r.lesson) : null)
        );
      });

      return react.createElement("div", { style: { padding: "8px 2px" } },
        headline,
        statsStrip,
        records.length === 0
          ? react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12px", padding: "12px 0" } },
              errorText ? "无法读取洞察账本（/api/dsh-llm-retry-escape/insights）" : "暂无记录——五种病理（死循环/活锁/伪进度/负进度/静默腐蚀）被监测到后会出现在这里。")
          : react.createElement("table", { style: TABLE_STYLE },
              react.createElement("thead", null, header),
              react.createElement("tbody", null, rows))
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        try {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-llm-retry-escape",
            order: 85,
            label: function () { return "反卡死历史"; },
            inject: function () { return {}; }
          }, InsightsCard);
        } catch (e) {
          return function () {};
        }
      });
    }

    exports.name = "dsh-llm-retry-escape";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
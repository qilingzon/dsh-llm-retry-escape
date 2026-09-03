# 架构与根因分析

本文说明 dsh-llm-retry-escape 在 DSH Desktop（cordis 插件体系）中的位置、它针对的三种失败死法、每层能力的源码级根因与设计取舍。

## 1. 系统上下文

```
DSH Desktop Host (cordis)
├── agent-loop               模型请求循环：build request → stream → tool calls → 下一 step
│   └── request-error 瀑布   请求失败时广播 agent/request-error，由监听者决定 retry 或放行失败
├── goal-round-driver        goal 轮驱动器：轮结束 → 排队下一轮（<goal_round> 提示）
│   └── 失败语义             agent/error → disarm（解除 goal 自动续跑武装）
├── dsh-goal                 goal 服务：create/pause/resume/disarm/complete/block
├── 内置 @deepseek-ai/dsh-llm-retry   ← 本插件通过 cordis.patch.yml 停用它并接管
└── 本插件 dsh-llm-retry-escape
    ├── inject: ["agents", "webServer", "goals"]
    ├── agent/request-error  → recover()：退避重试 / 逃生阀
    ├── agent/pre-step       → 策略注入 + 伪进度警告 + 解决记账
    ├── agent/turn-stopping  → 磁盘指纹 + 校验门 + 解决兜底
    ├── agent/status(idle)   → 阀后接力（goals.resume）
    └── webServer            → GET /api/dsh-llm-retry-escape/insights（loopback）
```

## 2. 三种失败死法（分诊优先）

传输层失败必须先分清死法再对症，混在一起看会得出错误结论：

| 死法 | 事件指纹 | 本质 | 对策层 |
|---|---|---|---|
| 中继掐流 | `TRANSPORT: terminated` | 流式输出 20-30s 后被中继/上游掐断；与**生成体积/时长**强相关 | 逃生阀止损 + 策略注入（改形状） |
| 流停滞 | `TIMEOUT: pi-ai stream idle timeout after 120000ms` | 流建立后停滞不吐 token，`streamIdleTimeoutMs` 到期 | 重试 + 退避封顶；多次则止损 |
| 整请求超时 | `SERVER/TIMEOUT: Request timed out.`，失败间隔 ≈ `timeoutMs` + 退避 | **思考阶段超过整请求上限**——活请求被当死请求杀 | **配置病**：调大 `timeoutMs`（插件治不了，但账本的失败码分类给了定位线索） |

实证教训（2026-09-03 armor-lab）：turn13 五连败全为 "Request timed out."、间隔 92s = 90s 上限 + 退避——max 推力 + 99K+ 上下文的思考阶段超过 90s，输出形状策略治不了它，`timeoutMs: 90000 → 600000` 才是解。

## 3. 各层根因链（源码级）

### 3.1 A1 逃生阀（为什么"无限重试"是错的）

内置重试对 `always` 策略无限重试。但中继掐流是**内容形状相关的确定性失败**：重试重建同样的请求 → 模型生成同样的巨型输出 → 同样被掐。实测（同一对话同一步）：6 败 1 成（运气）、30 败 0 成、化石记录 733 连败。逃生阀在连败 N 次后停止为本轮安排重试，把失败交还上层——**止损不是失败，是换策略的前置条件**。

### 3.2 A1-Relay（为什么阀后必须自愈 goal）

阀的返回值不能是 `{kind:"retry"}`（那就永远到不了止损），而 agent-loop 对 request-error 的非 retry 返回值一律抛 LlmError（`dsh-agent-loop/lib/index.js:666`）：

```js
const action = await this.dispatch.waterfall("agent/request-error", {...}, () => Promise.resolve(void 0));
if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
```

因此阀收尾的轮**必然以失败态结束** → Host 发出 `agent/error` → goal-round-driver 的处理是（`dsh-goal-round-driver/lib/index.js:201-203`）：

```js
ctx.on("agent/error", ({ agent }) => { disarm(stateFor(agent)); });
```

goal 一旦 disarm（`phase=active, activation=disarmed`），驱动器的 drive() 直接返回——**任务停摆等人工**。实测：正常轮结束 1 秒自动接力，阀收尾轮 15 分钟零接力。

修复：本插件监听 `agent/status(idle)`，对阀收尾的会话调 `ctx.goals.resume(agent, {id, revision})`。`dsh-goal/lib/index.js:619` 的 resume 允许 `active+disarmed → active+armed`（628 行对 already-armed 抛错，629 行对轮预算耗尽抛错——均被 guard 捕获）。resume 发出 `goal/change` 事件，反向触发驱动器的 requestDrive → 排队下一轮。轮预算由 `maxGoalRounds` 封顶，不会无限空烧。

**结构限制**：接力与注入无法合并为同一个 hook 调用——接力发生在轮结束瞬间（下一轮尚不存在），注入发生在下一轮入口（消息列表在 pre-step 才组装）。两个 hook，一个状态机。

### 3.3 A1-Coach（为什么策略必须注入而不只是记录）

接力解决的只是"有人接棒"，接棒后模型面对同样的上下文，仍会生成同样的巨型输出。账本里记一句"换新请求才是出路"是口号，不是措施——模型看不到账本。注入管道复用 B 哨兵验证过的 `agent/pre-step` decision.messages 追加机制（`form: "retry-strategy"`），把口号翻译成可执行指令：

1. 单次工具调用参数 ≤1500 字符
2. 大文件先写骨架，再分段追加，写一段验证一段
3. 一次只处理一个文件
4. 内容只进工具参数，严禁在回复里流式输出
5. 每段落盘后回读确认

效果判据：注入后每次尝试的生成时长降到中继存活窗口以下。实战：注入后 index.js 以 3.4K→4.6K→8.2K→16.4K 分段增长，目标 5 文件 34 分钟全部落盘（此前 4.5h 为 0）。

### 3.4 A2 探测节奏封顶

退避取 `min(initialDelayMs * 2^n, cap)`。内置 cap 来自 policy（可配 30000ms+）——死等 30 秒才发下一次探测，恢复感知慢。本插件把 cap 硬压到 5000ms（`ESCALATE_MAX_DELAY_MS`）：provider Retry-After ≤5s 尊重原值，>5s 压到 5s。

### 3.5 B 磁盘进度哨兵（伪进度）

重试风暴之外的第二类病：模型每轮都调工具但工作区零落盘（活锁/伪进度）。机制：pre-step 取工作区指纹（文件名|大小|mtime 递归，排除依赖目录），turn-stopping 再取对比；"调过工具 + 零变化" 记 zeroStreak，下一轮注入警告（1 轮提醒 / ≥2 轮升级"必须换方法"）；真实落盘 → 清零记解除。已知边界：纯读取型分析轮（调工具但不该写盘）会被误标——警告是咨询性的，v0.3.5 候选改进：只统计写入类工具。

### 3.6 C 洞察账本

一切检测事件的唯一落点：`$DSH_HOME\retry-insights.jsonl`（JSONL：ts/session/workspace/phenomenon/detail/resolved/lesson），宿主注册 loopback-only 的读取路由，client 在设置页渲染（5s 轮询）。设计原则：**发现本身要可见**——失败不是静默的，解决要有秒数，止损要有接力证据。

## 4. 兜底与守恒

- 哨兵/账本/校验门的任何异常都被 try/catch 吞掉——**永不打断主循环**
- normal 模式与内置实现逐字一致（不记账不注入）——普通用户零感知
- 轮预算由 goal `maxGoalRounds` 封顶——自动接力不会无限空烧
- subagent 会话跳过哨兵注入（发现/记账仍覆盖）
- 阀计数按 `(turn, step, provider, policyKey)` 精确隔离，互不污染

# dsh-llm-retry-escape

反卡死插件：替代内置 `@deepseek-ai/dsh-llm-retry`，v0.3.11。

## 功能

### A. request 层（模型请求失败恢复）
- **A1 逃生阀**：`retryPolicy.mode: always` 的 provider，同一 (turn, step, provider, policy)
  连续失败 30 次后停止重试、本轮干净收尾，交上层（goal / run_longtask.ps1）重发新请求。
  治"重连 40 多次连不上"的确定性失败死循环。`DSH_RETRY_ESCAPE_AFTER` 可调，`0` = 纯无限重试。
- **A1-Relay 阀后自动接力（v0.3.3）**：阀收尾的轮以失败态结束，goal-round-driver 会因
  `agent/error` 解除 goal 自动续跑武装，任务停摆等人工。本插件在轮空闲时自动 `goals.resume`
  重新武装，下一轮秒级接力（实测旧链路阀后 15 分钟零接力，monitor-armor3 valve-no-relay），
  轮预算仍由 `maxGoalRounds` 封顶。账本现象 `relay-rearmed`（青色 🔁）。
- **A1-Coach 失败步策略注入（v0.3.4）**：同一 (turn, step) 连败 ≥`DSH_RETRY_STRATEGY_AFTER`
  （默认 2）次时，下一轮入口注入「改变生成形状」策略——单次工具调用参数 ≤1500 字符、
  大文件骨架 + 分段 append、禁单次巨型生成。治本：中继掐长流是内容形状相关的确定性失败，
  重试/接力只是重发同样的巨型生成（armor-lab 实证 4.5h 40+ 败 0 文件落盘）。注入时机为
  下一轮入口（步内重试间无可注入钩子）。账本现象 `strategy-injected`（紫 📜）。
- **A2 探测节奏封顶**：重试间隔硬封顶 **5 秒**（v0.3.1 起由 30s 收紧）——网络恢复后
  ≤5s 必发出下一次重连，配合 `timeoutMs` / `streamIdleTimeoutMs` 快速检测。
  ⚠️ timeoutMs 部署值已由 90000 提到 **600000**（2026-09-03，armor-lab 实证：max 推理
  + 大上下文的思考阶段 >90s，整请求超时把活请求当死请求杀——turn13 五连败全为
  "Request timed out."，间隔 92s = 90s + 退避）；streamIdleTimeoutMs 保持 120000，
  死流仍在 2 分钟内暴露，误杀面不扩大。
- normal 模式与内置逐字一致。事件流（llm/retry、llm/retry-started）同形，UI 计数照常。

### B. turn 层磁盘进度哨兵（自动，无需配置）
- 自动监视**每个根会话自己的工作区**（`agent.session.header.cwd`；`DSH_PROGRESS_WATCH_DIR`
  可全局覆盖为固定目录）。判定纪律：
  - 轮内调用过工具（在干活）但工作区指纹零变化 → 记 zeroStreak（伪进度嫌疑）；
  - **纯聊天轮不惩罚**——聊天本来就不写盘；
  - 出现真实落盘 → streak 清零并记「伪进度解除」；
  - streak ≥1 下一轮注入 `progress-warning` 警告；streak ≥2 升级"必须换方法"。
- 指纹排除 `node_modules/.git/.venv/venv/__pycache__`（`DSH_PROGRESS_EXCLUDES` 可追加），
  走查上限 20000 项。subagent 会话跳过。哨兵任何异常都不打断主循环。
- **分工**：本插件只"检测 + 提醒换策略"；强制杀轮接力由外层 `run_longtask.ps1` 负责。

### C. 洞察账本 + 设置页「反卡死历史」面板
- 检测事件追加到 `$DSH_HOME\retry-insights.jsonl`（时间/会话/工作区/现象/详情/状态/经验），
  覆盖五类病理：死循环 / 活锁 / 伪进度 / 负进度 / 静默腐蚀；外层接力器与**测试套件**
  也写同一账本（测试记录 phenomenon=test，面板显示 🧪 蓝色标签）。
- **发现/解决即记账（v0.3.2）**：always 模式每次失败即记 `retry-detected`（黄·含失败码与退避），
  重试后该步完成记 `retry-resolved`（绿✅·含发现→解决全程秒数）——重试级事件不再只进
  会话事件流，面板全程可见；normal 模式保持与内置逐字一致，不记账。
- 宿主注册 `GET /api/dsh-llm-retry-escape/insights`（loopback 限定，非 loopback 403）；
  客户端在 **设置 → 反卡死历史** 渲染历史表，5s 自动刷新。

### D. turn 层负进度/静默腐蚀校验门（opt-in）
- 设 `DSH_PROGRESS_CHECK_CMD=<命令>` 启用：工作区出现变化后自动运行校验
  （cwd=工作区，`DSH_PROGRESS_CHECK_TIMEOUT_MS` 超时默认 120s，退出码 0=通过）。
- 失败 → 记 regression 账本 + 下一轮注入校验警告（含输出尾部）；
  恢复通过 → 记 regression-resolved。校验命令无法创建（受限环境）时按"校验失败"
  处理，**绝不打断哨兵簿记**。**校验写多深，腐蚀防线就多深——没有银弹**。

### E. 通用兜底重试（v0.3.9 / v0.3.10）
- provider 未配 `retryPolicy` 时宿主会注入默认 `normal + maxRetries=5`：TRANSPORT 耗尽即暴毙、
  PI_AI_ERROR 第 1 次就击穿主循环（GUI「本轮运行失败」）。本插件把「宿主默认策略」自动升级为
  `UNIVERSAL_DEFAULT_POLICY`（mode: always / 1s 起退避 / 30s 上限 / 抖动 0.2），零配置对所有
  provider 生效；provider 显式配置策略则优先。
- v0.3.11 起默认策略识别改为**结构判定**（normal + maxRetries≤5 + 码表含 TRANSPORT/SERVER），
  宿主改默认值不再静默失效。`DSH_RETRY_FALLBACK_MODE=off` 可关。

### F. v0.3.11 成本/误报治理（行为变更）
- 哨兵只认**写意图**（写工具白名单 + shell 写命令）；`Get-ChildItem`、`git status`、`2>&1`
  之类只读命令不再算"干活"，空工作区/纯调查轮不再被误判伪进度。
- 指纹超 2 万上限被截断时**关闭该会话的伪进度判定**（只记 `pseudoprogress-unreliable`）。
- 指纹扫描改为**只读轮不扫 + 64 并发 stat**；armor-lab（74k 文件）turn 边界成本从 3.6s 级降到亚秒级。
- 风暴已解决（同 (turn,step) 已有 `step/end`）→ 不再注入"改生成形状"指令（记 `strategy-skipped-resolved`）。
- always 模式对致命码（AUTH/INVALID_REQUEST/CONTEXT_LENGTH_EXCEEDED/MALFORMED_REQUEST/CANCELLED/ABORTED）
  不重试，记 `retry-skipped-fatal`。
- 风暴总时长闸 `DSH_RETRY_STORM_MAX_MS`（默认 180s）：不再等满 5×120s。
- provider 冷却：10 分钟内第 2 次阀 → 冷却 60s 起指数退避（上限 5 分钟），冷却期内失败 1 次即止损，
  接力延后到冷却结束。
- 注入预算（策略/进度各 ≤3 条/会话，风暴痊愈后策略预算复位）+ 同文本 5 轮去重；抑制记
  `injection-suppressed`。所有注入文案前缀标明「〔自动提示·非用户指令〕」。
- 策略话术：工具参数上限 1500→4000 字符，<3000 字符的单文件允许一次写完；删除绝对化措辞。

## 环境变量（Host 启动时读一次，改后需重启）

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_RETRY_ESCAPE_AFTER` | `30` | 连续失败多少次收尾本轮；`0` = 纯无限重试 |
| `DSH_RETRY_STRATEGY_AFTER` | `2` | 同一步连败多少次后下一轮注入生成形状策略；`0` = 关闭 |
| `DSH_RETRY_STRATEGY_MAX_LEVEL` | `2` | v0.3.6 升级阶梯：2=注入后风暴仍在→升级「拆任务」；1=永不升级（0.3.5 行为）；0=关闭整个策略注入 |
| `DSH_RETRY_LEDGER_MAX_BYTES` | `5242880` | v0.3.7 账本轮转上限（默认 5MB；现有文件+本条将超限时归档后续写；0=关闭） |
| `DSH_CONFIG_DISEASE_MIN_MS` | `20000` | v0.3.5 配置病诊断的失败间隔中位下限（低于此值不判配置病；测试可调小） |
| `DSH_PROGRESS_WATCH_DIR` | 未设（自动监视会话工作区） | 哨兵监听目录全局覆盖 |
| `DSH_PROGRESS_EXCLUDES` | `node_modules,.git,.venv,venv,__pycache__` | 指纹排除目录，逗号分隔 |
| `DSH_PROGRESS_CHECK_CMD` | 未设（关） | 功能 D 校验命令（cwd=工作区，退出码 0=通过） |
| `DSH_PROGRESS_CHECK_TIMEOUT_MS` | `120000` | 校验超时 |
| `DSH_RETRY_FALLBACK_MODE` | `always` | 宿主默认策略的升级模式；`off`/`none` = 保持宿主原样 |
| `DSH_RETRY_STORM_MAX_MS` | `180000` | 同一步从首败起的墙钟止损上限（0 = 关闭，回退纯次数闸） |
| `DSH_PROGRESS_MIN_STREAK` | `1` | 伪进度 streak 达到几轮才注入（2 = 更保守） |
| `DSH_RETRY_INJECT_BUDGET` | `3` | 每会话每类注入上限（0 = 不限） |

部署值（2026-09-03 用户设定）：`DSH_RETRY_ESCAPE_AFTER=5`——用户级环境变量已设 +
`run_longtask.ps1` 接力器进程内注入，**重启 Host 生效**（连败 5 次收尾本轮，实测 30 次要磨 66 分钟）。
v0.3.11 新增阈值均取保守默认（风暴闸 180s / 注入预算 3 / 伪进度 streak≥1），不改上述部署值。

## 装配

`cordis.patch.yml` 两行捆绑：停用内置 `llm-retry` 行 + 挂载本插件。
卸载本 bundle 即自动还原内置，原子回滚。

## 安装位置（desktop profile）

| 份 | 路径 |
|---|---|
| 源码包（版本化） | `D:\deepseek\retry-lab\dsh-llm-retry-escape\` |
| 主 home 插件源 | `C:\Users\qiling\.dsh\plugins\dsh-llm-retry-escape\` |
| profile 实装 | `C:\Users\qiling\.dsh\profiles\desktop\node_modules\dsh-llm-retry-escape\` |

同步命令（改完源码后跑，5 个文件）：
```powershell
$src = 'D:\deepseek\retry-lab\dsh-llm-retry-escape'
Copy-Item "$src\index.js","$src\client.js","$src\package.json","$src\cordis.patch.yml","$src\README.md" 'C:\Users\qiling\.dsh\plugins\dsh-llm-retry-escape\' -Force
Copy-Item "$src\index.js","$src\client.js","$src\package.json","$src\cordis.patch.yml","$src\README.md" 'C:\Users\qiling\.dsh\profiles\desktop\node_modules\dsh-llm-retry-escape\' -Force
```

验证插件加载：`dsh --dump-config`（llm-retry 行 disabled: true、llm-retry-escape 行在列）。
改 env / 装插件后需重启 Host。

## 测试（全绿为发布门）

```powershell
cd D:\deepseek\retry-lab
node tests\test_plugin.mjs          # A1/A2/B 哨兵（14 条）
node tests\test_cd.mjs              # C 路由 + D 校验门（6 条）
$env:DSH_RETRY_ESCAPE_AFTER='0'; node tests\test_escape0.mjs; Remove-Item Env:DSH_RETRY_ESCAPE_AFTER  # 纯无限重试（1 条）
node tests\test_relay_v033.mjs      # A1-Relay 阀后接力（8 条）
node tests\test_strategy_v034.mjs   # A1-Coach 策略注入（8 条）
node tests\test_v035.mjs            # config-disease/自适应话术/哨兵过滤（8 条）
node tests\test_v036_ladder.mjs     # v0.3.6 升级阶梯（4 条）
node tests\test_v036b_housekeeping.mjs # v0.3.7 账本治理（4 条：limit/轮转/日志保留）
node tests\test_v038_api.mjs         # v0.3.8 会话事件 API 兼容（10 条：snapshotEvents/旧 .events/空/抛错）
node tests\test_v039_fallback.mjs    # v0.3.9 通用兜底策略（6 条）
node tests\test_v0311.mjs            # v0.3.11 体检修复（10 条：写意图/截断降级/预算/致命码/风暴闸/冷却）
powershell -File tests\test_relay.ps1 # run_longtask.ps1 五判据 E2E（15 条）
powershell -File tests\test_goal_e2e.ps1 # goal 全周期真实链路 E2E（5 条；真实 headless 链烧 token，按需跑）
```

测试结果自动以 🧪 记录写入洞察账本 → 设置 → 反卡死历史 面板可见（用户要求的可观测性）。

## 更新日志

- **0.3.11**（体检定点修复：误报 / 质量 / 效率 / token 成本）实证驱动：账本 3865 条显示
  伪进度误报集中在空工作区（`D:\deepseek\1` 0 文件）与 74k 文件的 armor-lab（指纹 20k 截断）；
  单步 5 连败实测 493s/518s；指纹扫描实测 3622ms/次、每轮 2 次且在模型请求前 await。
  修复：①哨兵只认写意图（写工具白名单 + shell 写命令；只读命令/`2>&1` 不算）；
  ②指纹截断 → 该会话关闭伪进度判定（`pseudoprogress-unreliable`）；③指纹只读轮不扫 + 64 并发 stat；
  ④风暴已解决不再注入（`strategy-skipped-resolved`）；⑤致命码不重试（`retry-skipped-fatal`）；
  ⑥风暴总时长闸 180s（`storm-timeout`）；⑦provider 冷却 + 接力延后（`provider-cooldown`）；
  ⑧注入预算 3 条/类 + 5 轮去重（`injection-suppressed`）；⑨注入前缀「〔自动提示·非用户指令〕」；
  ⑩策略话术 1500→4000 字符、允许 <3000 字符单文件整写、删除绝对化措辞；
  ⑪宿主默认策略改结构判定。新增 tests/test_v0311.mjs 10/10，全量 10 套 78 断言全绿。
- **0.3.10**（拦截并升级 DSH 原生默认注入策略）宿主在 provider 未配 retryPolicy 时注入的是
  `{mode:"normal", maxRetries:5, codes:[EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT]}`
  而不是 undefined，导致 v0.3.9 兜底不触发、PI_AI_ERROR 第 1 次即击穿、TRANSPORT 5 次耗尽暴毙。
  改造：`isDshDefaultPolicy` 命中即升级为 `UNIVERSAL_DEFAULT_POLICY`（always + 逃生阀 + 接力），
  normal 模式下把 PI_AI_ERROR 纳入可重试。
- **0.3.9**（通用重试兜底）provider 未配 retryPolicy 时旧逻辑直接放行给宿主（无重试）→
  GUI「本轮运行失败 PI_AI_ERROR」。新增 `UNIVERSAL_DEFAULT_POLICY`（always / 1s 起退避 /
  30s 上限 / 抖动 0.2）零配置覆盖所有 provider；`DSH_RETRY_FALLBACK_MODE` 可关。
- **0.3.8**（致命兼容修复）**DSH 2.0.9 移除了 `Session.events`**——本插件旧写法
  `agent.session.events.findLast(...)`（阀计数两处）读到 undefined，导致**每次 provider 请求失败
  都抛 `TypeError: Cannot read properties of undefined (reading 'findLast')`**，轮直接被记失败
  （GUI「本轮运行失败」），且重试阀/接力/记账同时停摆。修复：新增 `sessionEvents(agent)` 兼容层
  ——优先 `snapshotEvents()`（2.0.9+），回退 `.events`（旧版/测试桩），取快照异常返回 `[]`
  绝不外溢主循环；三处调用点统一走该层。新增 `tests\test_v038_api.mjs` 10/10。
  证据：app.asar 2.0.9 Session 类声明只有 `snapshotEvents()/ownEvents()`；`.dsh\sessions` 全量扫描
  33 处 `turn/end` 该错误，最早 09-11T01:48Z（晚于 2.0.9 落地 09-10 22:29）。
- **0.3.7** 账本治理三件套：①`/insights` 接口 limit 截断——默认返回最近 500 条（`?limit=N` 可调），
  响应新增 `total`/`limit` 字段，面板 headline 显示「最近 N / 共 M 条」——面板体量与账本体量解耦
  （账本涨到几十 MB 时面板每 5s 轮询只传最近窗口，不再全量解析）。②账本大小轮转——现有文件
  + 本条将超 `DSH_RETRY_LEDGER_MAX_BYTES`（默认 5MB，0=关闭，动态读 env）时改名归档为
  `retry-insights-archive-<时间戳>.jsonl` 后续写；归档失败不阻塞记账。③monitor-multi 日志
  7 天自动清理（启动时清自身过期 `monitor-multi-*.log`；`DSH_MONITOR_LOG_DIR` 可覆写目录）。
  动机：账本两天 754 条 / 263KB（81% 为 retry-detected/resolved 高频条目），无界增长先痛面板轮询。
  测试：test_v036b_housekeeping 4/4 + 全量回归 9 套 68 断言全绿。
- **0.3.6** A1-Coach 升级阶梯：策略注入不再原地重复——注入后风暴仍在（下一轮入口仍有待注入
  记录）→ 阶梯+1，第 2 级起改发「拆任务」升级话术（拆 ≥3 小步写 progress.md / 本轮只做第一小步 /
  缩减版骨架 / blocked 换路径），新账本现象 `strategy-escalated`；风暴痊愈（某轮入口无待注入
  记录）→ 复位 L1。新增 `DSH_RETRY_STRATEGY_MAX_LEVEL`（默认 2；1=永不升级；0=关闭注入）。
  测试：test_v036_ladder 4/4 + 全量回归 8 套 64 断言全绿。
  设计要点：**阶梯键=agentId**——turn 每轮递增，按 (turn,step) 匹配永远升不了级。
  同版附带：client 面板统计卡（按现象聚合的色点计数条，未知现象兜底）+ tests\test_goal_e2e.ps1
  （goal 全周期真实链路 E2E：headless 型 profile + create_goal + 磁盘判据，5 断言，按需跑）。
- **0.3.5** config-disease 自动诊断（"Request timed out." 同码连败 + 间隔≈常数 → ⚙️ 配置病 +
  timeoutMs 建议）；策略注入按失败码自适应话术（限流节奏/网关/生成形状三分支）；B 哨兵只认
  写入类工具（`READ_ONLY_TOOL_RE`，修监测会话自身误报）。test_v035 8/8。（补记：上一会话
  发布时遗漏本条目）
- **0.3.4** A1-Coach 失败步策略注入：同一 (turn, step) 连败 ≥2（`DSH_RETRY_STRATEGY_AFTER` 可调）
  → 下一轮 pre-step 注入「改变生成形状」策略消息（小块输出/骨架+分段 append/禁单次巨型生成，
  form=retry-strategy）；新增账本现象 `strategy-injected` 与 client 标签。实证动机：armor-lab
  中继掐长流为内容形状相关的确定性失败，重试/接力不改变形状则 0 文件落盘（4.5h 40+ 败）。
- **0.3.3** A1-Relay 阀后自动接力：监听 `agent/status(idle)`，阀收尾的轮结束时对
  `active+disarmed` 的 goal 调 `goals.resume` 重新武装，`goal/change(resume)` 反向触发
  goal-round-driver 排队下一轮——修复"阀止损后任务停摆等人工"的断链（实测阀后 15 分钟
  零接力）；新增账本现象 `relay-rearmed` 与 client 标签；新增 test_relay_v033.mjs 单测。
  依据：dsh-goal-round-driver `agent/error → disarm` + dsh-goal `resume` 转换规则（源码核实）。
- **0.3.2** C 扩展「发现/解决即记账」：always 模式 `retry-detected` / 完成记 `retry-resolved`
  （含全程秒数），client 面板加两行现象标签；部署值 `DSH_RETRY_ESCAPE_AFTER=5`。
  实测依据：armor-lab turn3 风暴 30 连败磨 66 分钟才触发旧阀（15:24:25 逃生阀首条 live 记录）。
- **0.3.1** A2 探测封顶 30s→5s；insightsPath 动态读 DSH_HOME；导出 `_internal` 测试钩子；
  校验门 spawn 失败按失败处理（不再打断簿记）+ 注入式 checkRunner；client 面板加 🧪 测试套件标签；
  测试套件四套（36 条）全绿，测试结果入账本。
- **0.3.0** 新增 C（洞察账本 + 设置页面板）与 D（负进度校验门）；B 改自动监视会话工作区。
- **0.2.0** 新增 B：turn 层磁盘进度哨兵（opt-in，警告注入）；包内补齐 README。
- **0.1.2** 探测节奏硬封顶 30s（阶梯退避取消）。
- **0.1.1** 逃生阀 + 阶梯退避（封顶 5 分钟）。
- **0.1.0** 初版：替代内置 llm-retry，逃生阀 30 次。

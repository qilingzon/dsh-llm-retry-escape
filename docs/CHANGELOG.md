# 更新日志 — dsh-llm-retry-escape

## 0.3.4（2026-09-03）

**A1-Coach 失败步策略注入**：同一 `(turn, step)` 连败 ≥2（`DSH_RETRY_STRATEGY_AFTER` 可调）→ 下一轮 pre-step 注入 `retry-strategy` 策略消息：单次工具调用参数 ≤1500 字符 / 大文件骨架 + 分段追加 / 禁单次巨型生成 / 内容只进工具参数。

- 动机（实证）：中继掐长流是**内容形状相关的确定性失败**——重试与接力只是重发同样的巨型生成。实战记录：armor-lab 目标 4.5h 40+ 败 0 文件落盘；注入生效后 34min 75 步 7 文件，且 index.js 3.4K→16.4K 的分段追加增长肉眼可见。
- 注入时机为下一轮入口：agent-loop 步内重试间无可注入钩子（步内插消息会破坏会话不变式）。
- 新增账本现象 `strategy-injected`（紫 📜）与 client 标签；`progressNotice` 增加 form 参数。
- 新增 `tests/test_strategy_v034.mjs`（8 条：注入/去重/阈值边界/subagent/normal 隔离/与伪进度叠加）。

## 0.3.3（2026-09-03）

**A1-Relay 阀后自动接力**：监听 `agent/status(idle)`，阀收尾的轮结束时对 `active+disarmed` 的 goal 调 `goals.resume({id, revision})` 重新武装，`goal/change(resume)` 反向触发 goal-round-driver 排队下一轮。

- 根因（源码核实）：agent-loop 对 request-error 非 `{kind:"retry"}` 返回值一律抛 LlmError（`dsh-agent-loop lib/index.js:666`）→ 轮以失败态结束 → goal-round-driver 监听 `agent/error` 即解除 goal 武装（`dsh-goal-round-driver lib/index.js:201-203`）→ 阀止损后任务停摆等人工（实测阀后 15 分钟零接力）。
- guard 全覆盖：无 goals 服务 / 无 goal / 已 armed / 轮预算耗尽抛错——均不打断主循环；轮预算仍由 `maxGoalRounds` 封顶。
- 新增账本现象 `relay-rearmed`（青 🔁）；新增 `tests/test_relay_v033.mjs`（8 条）。
- 实测：19:17 重启生效后 18:08→19:50 两次真机全周期（阀 → 0 分钟接力 → 策略注入）。

## 0.3.2（2026-09-03）

**C 扩展「发现/解决即记账」**：always 模式每次失败记 `retry-detected`（黄，含失败码与退避毫秒），重试后该步完成记 `retry-resolved`（绿 ✅，含发现→解决全程秒数，按 `(turn, step)` 去重，轮末兜底）。重试级事件不再只进会话事件流，「反卡死历史」面板全程可见。normal 模式保持与内置逐字一致，不记账。client 面板新增两行现象标签。

## 0.3.1（2026-09-03）

- A2 探测节奏封顶 30s → **5s**（重试间隔硬封顶，阶梯退避取消后由固定封顶兜底）。
- insightsPath 动态读取 `DSH_HOME`（运行期改 env 也生效）。
- 导出 `_internal`（appendInsight / makeInsightsRoute / insightsPath / `__setCheckRunner`）测试钩子。
- 校验门 spawn 失败按"校验失败"处理，不再打断哨兵簿记 + 注入式 checkRunner。
- client 面板加 🧪 测试套件标签（测试结果入账本，面板可见）。

## 0.3.0（2026-09-03）

- **C** 洞察账本：检测事件追加 `$DSH_HOME\retry-insights.jsonl`，宿主注册 `GET /api/dsh-llm-retry-escape/insights`（loopback 限定），设置页「反卡死历史」面板 5s 轮询。
- **D** 负进度/静默腐蚀校验门（opt-in）：`DSH_PROGRESS_CHECK_CMD`。
- B 改为自动监视各根会话自己的工作区（`agent.session.header.cwd`）。

## 0.2.0（2026-09-03）

- **B** turn 层磁盘进度哨兵：轮内调用过工具但工作区指纹零变化 → zeroStreak；下一轮注入 progress-warning（1 轮提醒 / ≥2 轮"必须换方法"）；真实落盘 → streak 清零并记解除。纯聊天轮不惩罚；subagent 跳过；指纹排除 node_modules/.git/.venv/venv/__pycache__，走查上限 20000 项。

## 0.1.2

- A2 探测节奏硬封顶 30s（阶梯退避取消）。

## 0.1.1

- 逃生阀 + 阶梯退避（封顶 5 分钟）。

## 0.1.0

- 初版：替代内置 `@deepseek-ai/dsh-llm-retry`，逃生阀 30 次（always 模式）。

## 部署注记（非代码变更）

- `DSH_RETRY_ESCAPE_AFTER=5`（用户级环境变量 + run_longtask.ps1 接力器注入，2026-09-03 设定；默认 30 的实测代价：单步 66 分钟）。
- `timeoutMs` 建议值 600000（settings.yaml provider 级；90s 实测把 max 推力的思考期当死请求杀——turn13 五连败全为 "Request timed out."，间隔 92s = 90s + 退避）。

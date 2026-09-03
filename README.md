# dsh-llm-retry-escape

> DSH Desktop 反卡死插件：重试逃生阀 + 阀后自动接力 + 失败步策略注入 + 磁盘进度哨兵 + 洞察账本（五类病理全监测）。

替代 DSH Desktop 内置的 `@deepseek-ai/dsh-llm-retry`。设计目标：**模型请求失败时，会话不死、不空转、不停摆——每一步都有人接、每一步都留痕迹。**

## 它解决什么问题

LLM 中继（relay）环境下的请求失败有三种死法，普通的"无限重试"一种都治不了：

| 死法 | 症状 | 本插件的对策 |
|---|---|---|
| 中继掐流 | 流式输出 20-30s 后连接被掐（`terminated`） | 逃生阀止损 + 策略注入改变生成形状 |
| 整请求超时 | 思考阶段超过 `timeoutMs` 上限（`Request timed out.`） | 属于**配置病**——`timeoutMs` 必须容纳 max 推力的思考期（本插件会在账本里留下分类线索） |
| 流停滞 | 流卡住不再吐 token（stream idle timeout） | 退避封顶快速重试；多次则止损 |

三种死法叠加在一个长任务上的后果：同一步骤反复失败、任务停摆数小时、0 产出。本插件在 DSH 的 agent-loop 与 goal 轮驱动器之间补全了"止损 → 接力 → 教练 → 可见"的完整闭环。

## 五层防护

| 层 | 能力 | 触发条件 | 效果 |
|---|---|---|---|
| A1 逃生阀 | 连败收尾 | 同一 `(turn, step, provider, policy)` 连败 `DSH_RETRY_ESCAPE_AFTER` 次（默认 5） | 停止无意义重试，收尾本轮（旧默认 30 次 + 30s 退避 = 实测单步卡 66 分钟；5 次 ≈ 8-16 分钟） |
| A1-Relay 阀后自动接力 | goal 自愈 | 阀收尾的轮空闲时（`agent/status` idle） | 对 `active+disarmed` 的 goal 调 `goals.resume` 重新武装，下一轮秒级自动接力（实测旧链路阀后 15 分钟零接力） |
| A1-Coach 失败步策略注入 | 生成形状教练 | 同一步连败 ≥`DSH_RETRY_STRATEGY_AFTER` 次（默认 2） | 下一轮入口注入策略：单次工具参数 ≤1500 字符、大文件骨架+分段追加、禁单次巨型生成 |
| A2 探测节奏封顶 | 快速重试 | 每次重试调度 | 退避硬封顶 5s（旧 30s） |
| B 磁盘进度哨兵 | 伪进度检测 | 轮内调用过工具但工作区零落盘 | 注入升级警告（1 轮提醒 / ≥2 轮"必须换方法"） |
| C 洞察账本 | 全程可见 | 每次发现/解决/止损/接力/注入 | 追加 `$DSH_HOME\retry-insights.jsonl`，设置页「反卡死历史」5s 刷新 |
| D 负进度校验门 | 回归检测 | opt-in：`DSH_PROGRESS_CHECK_CMD` | 工作区有变化但校验失败 → 注入警告；恢复 → 记解除 |

normal 重试策略模式与内置实现逐字一致（不记账、不注入），普通用户零感知。

## 实战数据（2026-09-03，真实中继故障日）

修复前后，同一任务、同一中继、同一对话：

| 指标 | 修复前 4.9h | 修复后 34min |
|---|---|---|
| 步数推进 | 反复卡死同一步 | 75 步 |
| 目标产物落盘 | **0 个文件** | **7 个文件** |
| 单步最长卡死 | 30 连败 66 分钟 / 化石记录 733 连败 | 5 连败 8-16 分钟 |
| 阀后接力 | 15 分钟零接力（停摆等人工） | **0 分钟**（同秒接力） |
| 单步大文件写法 | 单次巨型生成 → 被掐 | 骨架 + 分段追加（index.js 3.4K→16.4K 递增可见） |

完整时间线与逐层验收证据见 [docs/FIELD-REPORT.md](docs/FIELD-REPORT.md)。

## 安装

要求：DSH Desktop（cordis 插件体系）。

```powershell
# 1) 克隆
git clone https://github.com/qilingzon/dsh-llm-retry-escape.git
# 2) 复制到 DSH 插件目录（Windows 示例，$env:USERPROFILE\.dsh 下）
Copy-Item dsh-llm-retry-escape\* $env:USERPROFILE\.dsh\plugins\dsh-llm-retry-escape\ -Recurse -Force
# 3) 同步到 profile 实装点（desktop profile 示例）
Copy-Item dsh-llm-retry-escape\* $env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-llm-retry-escape\ -Recurse -Force
# 4) 重启 DSH Desktop（插件与配置均启动时读取）
# 5) 验证：设置 → 反卡死历史 面板出现；或 dsh --dump-config 确认 llm-retry disabled + 本插件在列
```

`cordis.patch.yml` 两行捆绑：停用内置 `llm-retry` + 挂载本插件。卸载本 bundle 即自动还原内置，原子回滚。

## 环境变量（Host 启动时读一次，改后需重启）

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_RETRY_ESCAPE_AFTER` | `30` | 同一步连败多少次收尾本轮；`0` = 纯无限重试。**推荐 5** |
| `DSH_RETRY_STRATEGY_AFTER` | `2` | 同一步连败多少次后下一轮注入生成形状策略；`0` = 关闭 |
| `DSH_PROGRESS_WATCH_DIR` | 未设（自动监视会话工作区） | 哨兵监听目录全局覆盖 |
| `DSH_PROGRESS_EXCLUDES` | `node_modules,.git,.venv,venv,__pycache__` | 指纹排除目录 |
| `DSH_PROGRESS_CHECK_CMD` | 未设（关） | 功能 D 校验命令（cwd=工作区，退出码 0=通过） |
| `DSH_PROGRESS_CHECK_TIMEOUT_MS` | `120000` | 校验超时 |

配套 Host 配置建议（settings.yaml，provider 级）：`timeoutMs` 必须容纳 max 推力的思考期（实测 90s 会把活请求当死请求杀，推荐 600000）；`streamIdleTimeoutMs: 120000` 保持不变，死流 2 分钟内照死。

## 测试（五套 37 断言）

```powershell
node tests\test_plugin.mjs          # A1/A2/B 哨兵（14 条）
node tests\test_cd.mjs              # C 路由 + D 校验门（6 条）
$env:DSH_RETRY_ESCAPE_AFTER='0'; node tests\test_escape0.mjs   # 纯无限重试（1 条）
node tests\test_relay_v033.mjs      # 阀后自动接力 + guard 分支（8 条）
node tests\test_strategy_v034.mjs   # 策略注入 + guard 分支（8 条）
powershell -File tests\test_relay.ps1   # run_longtask 五判据 E2E（15 条）
```

测试结果以 🧪 记录写入洞察账本，「反卡死历史」面板可见。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与根因分析（三种死法、源码级根因链、设计取舍）
- [docs/FIELD-REPORT.md](docs/FIELD-REPORT.md) — 2026-09-03 实战战报（逐层验收证据）
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — v0.1.0 → v0.3.4 完整变更史
- [ops/](ops/) — 无人值守接力器 run_longtask.ps1（五判据）与全战役监视器

## License

MIT — 见 [LICENSE](LICENSE)。

# run_longtask.ps1 v3 - 无人值守长任务接力器（反死循环/活锁/伪进度/负进度版）
#
# 分层设计：
#   轮内（request 层）：provider retryPolicy mode=always 无限重试扛网络波动；
#     配合 dsh-llm-retry-escape 插件（逃生阀 + 30s 探测封顶 + 进度哨兵警告注入）。
#   轮间（task 层）：本脚本。四种卡死形态 + 一次兜底，全部以"磁盘关键状态"为准：
#     1) 超时：整轮超过 MaxSecondsPerAttempt                    → 杀掉接力
#     2) 活锁：StallMinutes 内 WorkDir 磁盘指纹零变化           → 杀掉接力
#     3) 伪进度：整轮结束磁盘产物与轮开始完全一致               → 下一轮注入零进展警告
#     4) 负进度：产物变化但校验脚本失败（回归反噬）             → 自动回滚到 last-good 快照
#   完成判定：TASK-DONE 哨兵 + 退出码 0 + 产物有变化 + 校验通过（如提供）。
#
# 负进度防线（-ValidateScript）：校验脚本以 WorkDir 为 cwd、WorkDir 为第一个参数，
#   退出码 0 = 通过。每个正常结束的轮次跑一次：
#     通过 → WorkDir 快照到 snapshots\last-good（最近良好状态）
#     失败 → 判负进度：自动 robocopy /MIR 回滚 last-good，失败史注入下一轮
#   被杀（超时/活锁）的轮次不校验不回滚——半成品状态交由下一轮继续，不冤枉。
#   没有校验脚本 = 无门禁，仅保留 last-good 审计快照。
#
# 用法：
#   .\run_longtask.ps1 -ProfileName desktop -Task "你的长任务指令"
#   .\run_longtask.ps1 -ProfileName desktop -Task "..." -ValidateScript "<repo>\ops\validate_example.ps1"
#   .\run_longtask.ps1 -ProfileName gen3-lab -DshHome "<lab-home>\gen3_home" -Task "..."
# 注意：同一 profile 不要 GUI 窗口和接力器同时跑。
param(
  [Parameter(Mandatory=$true)][string]$ProfileName,
  [Parameter(Mandatory=$true)][string]$Task,
  [string]$WorkDir = "",                       # 任务产物目录（progress.md 契约）；默认 $LogDir\work
  [string]$DshHome = "",                       # 可选，覆盖 DSH_HOME（实验室 profile 用 gen3_home）
  [int]$MaxSecondsPerAttempt = 3600,           # 单轮上限
  [int]$MaxAttempts = 12,                      # 最多接力轮数
  [int]$StallMinutes = 10,                     # 活锁判定：连续 N 分钟磁盘零变化
  [int]$PollSeconds = 60,                      # 磁盘指纹采样间隔
  [string]$ValidateScript = "",                # 校验脚本（负进度防线）；空 = 无门禁
  [int]$KeepSnapshots = 5,                     # 审计快照保留数
  [string]$ExePath = "D:\deepseek\DSH Desktop\DSH Desktop.exe",  # 可注入桩程序供测试
  [string]$CliPath = "D:\deepseek\DSH Desktop\resources\app.asar\lib\desktop-cli.js",
  [string]$LogDir = "$PSScriptRoot\out\longtask"
)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$exe = $ExePath
$cli = $CliPath

if ($WorkDir -eq "") { $WorkDir = Join-Path $LogDir "work" }
New-Item -ItemType Directory -Force -Path $WorkDir, $LogDir | Out-Null
$progressFile = Join-Path $WorkDir "progress.md"
$snapDir = Join-Path $LogDir "snapshots"
$lastGood = Join-Path $snapDir "last-good"
New-Item -ItemType Directory -Force -Path $snapDir | Out-Null

if ($ValidateScript -and (Test-Path $ValidateScript)) {
  $ValidateScript = (Resolve-Path $ValidateScript).Path
}
if ($ValidateScript -and -not (Test-Path $ValidateScript)) {
  Write-Warning "[longtask] ValidateScript 不存在：$ValidateScript —— 负进度门禁关闭"
  $ValidateScript = ""
}

$ResumeContract = @"
[接力约定 - 每一轮都必须遵守]
0) 本轮第一件事：用写入工具真实更新 $progressFile 的"当前动作"行，然后用读取工具回读确认已写入。
   禁止把"已写入/已完成"只写在回复文本里——一切以磁盘文件为准。
1) 每完成一个里程碑，立即落盘产物到 $WorkDir 并更新 progress.md。
2) 本轮结束前必须把断点写清（做到哪、下一步是什么、上一轮失败原因）。
3) 修复/重构类改动小步走：每改一处关键产物，立即运行验收校验（如提供），失败立即回退本步。
4) 全部完成后，在最终回复的最后一行单独输出：TASK-DONE
"@

function Get-TreeFingerprint([string]$dir) {
  if (-not (Test-Path $dir)) { return "" }
  $items = @(Get-ChildItem $dir -Recurse -File -Force -ErrorAction SilentlyContinue)
  if ($items.Count -eq 0) { return "" }
  return (($items | Sort-Object FullName | ForEach-Object {
    "{0}|{1}|{2}" -f $_.FullName.Substring($dir.Length), $_.Length, $_.LastWriteTimeUtc.Ticks
  }) -join "`n")
}

function Invoke-Validator {
  if (-not $ValidateScript) { return $true }
  $script:validationOut = ""
  if ([System.IO.Path]::GetExtension($ValidateScript) -eq ".ps1") {
    $script:validationOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ValidateScript $WorkDir 2>&1 | Out-String
  } else {
    Push-Location $WorkDir
    try { $script:validationOut = & $ValidateScript $WorkDir 2>&1 | Out-String } finally { Pop-Location }
  }
  return ($LASTEXITCODE -eq 0)
}

function Copy-Tree([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  robocopy $from $to /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  return ($LASTEXITCODE -lt 8)
}

# ── 洞察账本：接力器止损记录写入同一 jsonl（与 dsh-llm-retry-escape 设置页面板共用）──
$InsightsFile = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME "retry-insights.jsonl" } else { Join-Path $env:USERPROFILE ".dsh\retry-insights.jsonl" }
function Append-InsightRecord([string]$phenomenon, [string]$detail, [string]$resolved, [string]$lesson) {
  try {
    $rec = @{
      ts = (Get-Date -Format o); source = "relay"; session = "(headless:$ProfileName)"
      workspace = $WorkDir; phenomenon = $phenomenon; detail = $detail
      resolved = $resolved; lesson = $lesson
    }
    [System.IO.File]::AppendAllText($InsightsFile, (ConvertTo-Json -Compress -InputObject $rec) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rows = @()
$done = $false
$failureHistory = @()

for ($i = 1; $i -le $MaxAttempts -and -not $done; $i++) {
  $header = "[这是同一任务的第 $i 次接力，前几轮未完成]"
  if ($failureHistory.Count -gt 0) {
    $header += "`n[前几轮失败模式——本轮必须换方法，禁止重复同样策略]`n" + (($failureHistory | Select-Object -Last 3) -join "`n")
  }
  if ($i -eq 1) {
    $prompt = $Task + "`n`n" + $ResumeContract
  } else {
    $prompt = $Task + "`n`n" + $header + "`n" + $ResumeContract
  }
  $prompt = ($prompt -replace "`r`n", "`n")

  $outFile = Join-Path $LogDir ("{0}_attempt_{1}.txt" -f $stamp, $i)
  Write-Host "[longtask] 第 $i/$MaxAttempts 轮开始（上限 ${MaxSecondsPerAttempt}s，活锁 ${StallMinutes}min，门禁 $(if($ValidateScript){'开'}else{'关'})）..."
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $fStart = Get-TreeFingerprint $WorkDir

  $job = Start-Job -ScriptBlock {
    param($exe, $cli, $prof, $dshHomeVar, $work, $task)   # 注意：不能用 $home（只读自动变量）
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $env:ELECTRON_RUN_AS_NODE = "1"
    if ($dshHomeVar) { $env:DSH_HOME = $dshHomeVar }
    $env:DSH_RETRY_ESCAPE_AFTER = "5"   # 逃生阀阈值（2026-09-03 用户设定）：连败 5 次收尾本轮，与用户级环境变量一致
    if ($work) { Set-Location $work }                     # agent cwd=WorkDir：相对路径落对盘；哨兵自动监视 cwd
    & $exe --expose-internals $cli --profile $prof $task 2>&1 | Out-String
    "EXITCODE:$LASTEXITCODE"
  } -ArgumentList $exe, $cli, $ProfileName, $DshHome, $WorkDir, $prompt

  $out = $null; $timedOut = $false; $stalled = $false
  $fLast = $fStart; $stallSince = $null
  while ($true) {
    if (Wait-Job $job -Timeout $PollSeconds) { break }
    if ($sw.Elapsed.TotalSeconds -ge $MaxSecondsPerAttempt) { Stop-Job $job; $timedOut = $true; break }
    $fNow = Get-TreeFingerprint $WorkDir
    if ($fNow -ceq $fLast) {
      if (-not $stallSince) { $stallSince = Get-Date }
      elseif (((Get-Date) - $stallSince).TotalMinutes -ge $StallMinutes) { Stop-Job $job; $stalled = $true; break }
    } else { $fLast = $fNow; $stallSince = $null }
  }

  if ($timedOut) { $out = "[WATCHDOG-TIMEOUT after ${MaxSecondsPerAttempt}s]`n" + (Receive-Job $job | Out-String) }
  elseif ($stalled) { $out = "[WATCHDOG-LIVELOCK: ${StallMinutes} 分钟磁盘零变化，判活锁]`n" + (Receive-Job $job | Out-String) }
  else { $out = Receive-Job $job | Out-String }
  Remove-Job $job -Force
  $sw.Stop()

  $exitCode = "?"
  if ($out -match "EXITCODE:(-?\d+)") { $exitCode = $Matches[1] }
  $fEnd = Get-TreeFingerprint $WorkDir
  $zeroProgress = ($fEnd -ceq $fStart)
  $changed = -not $zeroProgress

  # ── 负进度门禁：只对正常结束的轮次校验（被杀的轮次是半成品，交下一轮继续，不冤枉）──
  $regression = $false; $rolledBack = $false; $valid = $true
  if ($ValidateScript -and -not $timedOut -and -not $stalled) {
    $valid = Invoke-Validator
    if (-not $valid) {
      $regression = $true
      if (Test-Path $lastGood) {
        if (Copy-Tree $lastGood $WorkDir) { $rolledBack = $true }
      }
    }
  }

  if (-not $timedOut -and -not $stalled -and -not $regression -and $changed) {
    # last-good 与审计快照只记"验证通过"的状态
    Copy-Tree $WorkDir $lastGood | Out-Null
    $audit = Join-Path $snapDir ("attempt_{0}" -f $i)
    Copy-Tree $WorkDir $audit | Out-Null
    $old = @(Get-ChildItem $snapDir -Directory -Filter "attempt_*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($old.Count -gt $KeepSnapshots) { $old | Select-Object -Skip $KeepSnapshots | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  }

  if (-not $timedOut -and $exitCode -eq "0" -and ($out -match "TASK-DONE") -and -not $zeroProgress -and $valid) { $done = $true }

  if ($timedOut) {
    $failureHistory += "第 $i 轮：超时 ${MaxSecondsPerAttempt}s 未完成"
    Append-InsightRecord "relay-timeout" "第 $i 轮超时 ${MaxSecondsPerAttempt}s 未完成" "已止损：杀轮接力" "超时上限是产品参数不是墙——被杀轮次交下一轮继续"
  }
  elseif ($stalled) {
    $failureHistory += "第 $i 轮：活锁——${StallMinutes} 分钟磁盘零变化"
    Append-InsightRecord "relay-livelock" "第 $i 轮 ${StallMinutes} 分钟磁盘零变化" "已止损：杀轮接力" "动作不等于进展——只认磁盘"
  }
  elseif ($regression) {
    $rb = if ($rolledBack) { "已自动回滚到最近良好快照" } else { "无快照可回滚，需人工检查" }
    $failureHistory += "第 $i 轮：负进度——产物变化但校验失败$(if($rolledBack){'，已自动回滚到最近良好快照'}else{'（无快照可回滚，需人工检查）'})"
    Append-InsightRecord "relay-regression" "第 $i 轮产物变化但校验失败" $rb "修复前先有基线——last-good 只记验证通过的状态"
  }
  elseif ($zeroProgress) {
    $failureHistory += "第 $i 轮：伪进度——整轮结束磁盘产物零变化（说了没做/写错位置）"
    Append-InsightRecord "relay-zeroprogress" "第 $i 轮整轮零落盘" "已注入零进展警告" "说了没做=伪进度"
  }

  $out | Set-Content -Path $outFile -Encoding UTF8
  $rows += [pscustomobject]@{
    attempt = $i
    seconds = [int]$sw.Elapsed.TotalSeconds
    timedOut = $timedOut
    stalled = $stalled
    zeroProgress = $zeroProgress
    regression = $regression
    rolledBack = $rolledBack
    exit = $exitCode
    done = $done
    log = $outFile
  }
  Write-Host ("[longtask] 第 {0} 轮结束: {1}s, timeout={2}, livelock={3}, zeroProg={4}, regression={5}, rollback={6}, exit={7}, done={8}" -f `
    $i, [int]$sw.Elapsed.TotalSeconds, $timedOut, $stalled, $zeroProgress, $regression, $rolledBack, $exitCode, $done)
}

$csv = Join-Path $LogDir ("run_{0}.csv" -f $stamp)
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
Write-Host "=== longtask 汇总 ==="
$rows | Format-Table attempt, seconds, timedOut, stalled, zeroProgress, regression, rolledBack, exit, done -AutoSize | Out-String | Write-Host
if ($done) { Write-Host "[longtask] 任务完成（TASK-DONE + 磁盘产物已落盘$(if($ValidateScript){' + 校验通过'})）。" }
else { Write-Host "[longtask] 未完成，断点在 $progressFile，失败史已注入下一轮；最近良好快照：$lastGood" }
Write-Host "结果已写入 $csv"

# test_relay.ps1 — run_longtask.ps1 v3 的 E2E 测试驱动（桩 agent，不起真实 DSH）
# 覆盖：T1 直接完成 / T2 伪进度接力 / T3 负进度回滚 / T4 超时杀轮 / T5 活锁杀轮
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$lab = Split-Path $here -Parent
$relay = Join-Path $lab "ops\run_longtask.ps1"
$stub = Join-Path $here "stub_agent.ps1"
$launcher = Join-Path $here "stub_launcher.cmd"
$validator = Join-Path $lab "ops\validate_example.ps1"
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("rl-e2e-" + (Get-Date -Format "HHmmss"))
$script:pass = 0; $script:fail = 0
function Check([string]$name, [bool]$cond) { if ($cond) { $script:pass++; Write-Host "PASS $name" } else { $script:fail++; Write-Host "FAIL $name" } }

function Run-Relay([string]$name, [string[]]$behaviors, [hashtable]$p = @{}) {
  $troot = Join-Path $root $name
  $work = Join-Path $troot "work"; $logd = Join-Path $troot "log"
  New-Item -ItemType Directory -Force -Path $work, $logd | Out-Null
  $ctrl = Join-Path $troot "ctrl.json"; $cnt = Join-Path $troot "cnt.txt"
  Set-Content -Path $ctrl -Value $behaviors -Encoding UTF8   # 纯文本逐行，一行一个行为
  if (Test-Path $cnt) { Remove-Item $cnt -Force }
  $env:RL_CTRL = $ctrl; $env:RL_CNT = $cnt
  $h = @{ ProfileName = "test"; Task = "t"; ExePath = $launcher; CliPath = $stub; WorkDir = $work; LogDir = $logd; MaxAttempts = 4; PollSeconds = 2; MaxSecondsPerAttempt = 8 }
  foreach ($k in @($p.Keys)) { $h[$k] = $p[$k] }
  & $relay @h > (Join-Path $logd "driver_out.txt") 2>&1
  $csvFile = Get-ChildItem $logd -Filter "run_*.csv" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $rows = @(Import-Csv $csvFile.FullName)
  return ,@($rows)
}

Write-Host "=== T1 直接完成 ==="
$r = Run-Relay "t1_done" @("done")
Check "T1 单轮结束" ($r.Count -eq 1)
Check "T1 done=True" ($r[0].done -eq "True")
Check "T1 非零进展" ($r[0].zeroProgress -eq "False")

Write-Host "=== T2 伪进度接力 ==="
$r = Run-Relay "t2_fake" @("fake", "done")
Check "T2 第1轮伪进度" ($r[0].zeroProgress -eq "True" -and $r[0].done -eq "False")
Check "T2 第2轮完成" ($r[1].done -eq "True")
Check "T2 共两轮" ($r.Count -eq 2)

Write-Host "=== T3 负进度回滚 ==="
$w3 = Join-Path $root "t3_regress\work"
$r = Run-Relay "t3_regress" @("valid", "regress", "done") @{ ValidateScript = $validator }
Check "T3 第1轮建基线（无TASK-DONE不完成）" ($r[0].done -eq "False" -and $r[0].zeroProgress -eq "False")
Check "T3 第2轮判负进度" ($r[1].regression -eq "True")
Check "T3 第2轮已回滚" ($r[1].rolledBack -eq "True")
Check "T3 第3轮完成" ($r[2].done -eq "True")
Check "T3 终态 product.json 合法" ((Get-Content (Join-Path $w3 "product.json") -Raw | ConvertFrom-Json).ok -eq $true)

Write-Host "=== T4 超时杀轮 ==="
$r = Run-Relay "t4_timeout" @("hang") @{ MaxSecondsPerAttempt = 5; MaxAttempts = 1 }
Check "T4 超时判定" ($r[0].timedOut -eq "True")
Check "T4 未误判完成" ($r[0].done -eq "False")

Write-Host "=== T5 活锁杀轮 ==="
$r = Run-Relay "t5_livelock" @("hang") @{ StallMinutes = 0; PollSeconds = 2; MaxSecondsPerAttempt = 30; MaxAttempts = 1 }
Check "T5 活锁判定" ($r[0].stalled -eq "True")
Check "T5 未误判完成" ($r[0].done -eq "False")

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "RESULT pass=$script:pass fail=$script:fail"

# v0.3.1：测试结果入洞察账本（设置页「反卡死历史」面板可见）
$InsightsFile2 = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME "retry-insights.jsonl" } else { Join-Path $env:USERPROFILE ".dsh\retry-insights.jsonl" }
try {
  $rec = @{
    ts = (Get-Date -Format o); source = "test-suite"; session = "tests/test_relay.ps1"; workspace = $lab
    phenomenon = "test"
    detail = "test_relay v3 E2E: pass=$script:pass fail=$script:fail（T1完成/T2伪进度/T3负进度回滚/T4超时/T5活锁）"
    resolved = $(if ($script:fail -eq 0) { "全部通过" } else { "存在失败 $script:fail 项" })
    lesson = "接力器五判据回归——测试记录入账本（用户要求历史可见）"
  }
  [System.IO.File]::AppendAllText($InsightsFile2, (ConvertTo-Json -Compress -InputObject $rec) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
} catch { }

exit $(if ($script:fail -gt 0) { 1 } else { 0 })

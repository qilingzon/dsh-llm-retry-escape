# stub_agent.ps1 — 接力器 E2E 测试桩：模拟 DSH CLI 的单轮行为
# 行为由 RL_CTRL（JSON 行为数组）+ RL_CNT（计数文件）控制，逐轮取一个行为：
#   done    → 写 progress.md + 合法 product.json，输出 TASK-DONE，exit 0
#   fake    → 什么都不写，只在输出里吹牛（伪进度），exit 0
#   regress → 写入损坏的 product.json + TASK-DONE（负进度），exit 0
#   valid   → 写入合法 product.json，但不说 TASK-DONE（制造 last-good 基线）
#   hang    → 睡 90s（超时/活锁测试用）
param($p1, $p2, $p3, $p4, $p5)
$ErrorActionPreference = 'Continue'
$ctrl = @("done")
if ($env:RL_CTRL -and (Test-Path $env:RL_CTRL)) {
  $ctrl = @(Get-Content $env:RL_CTRL | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$cntPath = $env:RL_CNT
$n = 0
if ($cntPath -and (Test-Path $cntPath)) { $n = [int](Get-Content $cntPath -Raw -ErrorAction SilentlyContinue) }
Set-Content -Path $cntPath -Value ($n + 1) -Encoding ASCII
$behavior = if ($n -lt $ctrl.Count) { [string]$ctrl[$n] } else { [string]$ctrl[$ctrl.Count - 1] }
switch ($behavior) {
  "done"    { Set-Content -Path "progress.md" -Value "did it"; Set-Content -Path "product.json" -Value '{"ok":true}'; Write-Output "TASK-DONE"; exit 0 }
  "fake"    { Write-Output "I totally wrote the files (not really)"; exit 0 }
  "regress" { Set-Content -Path "progress.md" -Value "broke it"; Set-Content -Path "product.json" -Value '{broken json'; Write-Output "TASK-DONE"; exit 0 }
  "valid"   { Set-Content -Path "product.json" -Value '{"ok":true}'; Write-Output "worked, not done yet"; exit 0 }
  "hang"    { Start-Sleep -Seconds 90; exit 1 }
  default   { exit 0 }
}
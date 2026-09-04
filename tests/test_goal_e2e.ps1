# test_goal_e2e.ps1 — v0.3.6 ③ goal 全周期真实链路 E2E（真实 dsh headless CLI + 真实 LLM + 真实 goal 引擎，无桩）
# 链路：headless 会话内 agent 用 create_goal 建目标（磁盘判据）→ goal-round-driver 排轮 → 执行落盘 → goal 完成。
# 断言（全磁盘）：
#   A1 产物存在且内容正确（goal-probe.txt == GOAL-E2E-OK）
#   A2 lab home 会话流含 goal 生命周期证据（create_goal 工具事件 + goal/* 生命周期事件 + complete 痕迹）
#   A3 CLI 退出码 0
# 运行：powershell -File tests\test_goal_e2e.ps1   （真实链路，耗时 2-10min，烧真实 token）
# 备注：desktop/web profile 的 app 收 0 个位置参数，位置任务是 headless 型 profile（gen*-hl）专属——
#       run_longtask.ps1 默认 -ProfileName desktop + 位置任务在真机上会被 CLI 拒绝（桩测试掩盖），待修。
param(
  [string]$ProfileName = "gen4-hl",
  [string]$DshHome = "D:\deepseek\armor-lab\gen4-lab\gen4_home",
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Continue'
$exe = 'D:\deepseek\DSH Desktop\DSH Desktop.exe'
$cli = 'D:\deepseek\DSH Desktop\resources\app.asar\lib\desktop-cli.js'
$sessionsRoot = Join-Path $DshHome "sessions"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$base = Join-Path $PSScriptRoot "..\out\goal-e2e\$stamp"
$work = Join-Path $base "work"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$probe = Join-Path $work "goal-probe.txt"
$report = Join-Path $base "report.txt"
$cut = Get-Date

$task = "Use the create_goal tool to create a goal: write exactly one line GOAL-E2E-OK into the file $probe , then read the file back to verify. Completion criterion: the file exists and its content is GOAL-E2E-OK. Use max_goal_rounds = 2. Execute the goal until it completes. Do nothing else beyond this goal."

Write-Host "[goal-e2e] work=$work"
Write-Host "[goal-e2e] dsh-home=$DshHome profile=$ProfileName"
$outFile = Join-Path $base "cli-output.txt"
$job = Start-Job -ScriptBlock {
  param($exe, $cli, $prof, $dshHome, $work, $task)
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $env:ELECTRON_RUN_AS_NODE = "1"
  $env:DSH_HOME = $dshHome
  $env:DSH_RETRY_ESCAPE_AFTER = "5"
  Set-Location $work
  & $exe --expose-internals $cli --profile $prof $task 2>&1 | Out-String
  "EXITCODE:$LASTEXITCODE"
} -ArgumentList $exe, $cli, $ProfileName, $DshHome, $work, $task

$sw = [Diagnostics.Stopwatch]::StartNew()
if (Wait-Job $job -Timeout $TimeoutSec) { Write-Host "[goal-e2e] CLI finished in $([int]$sw.Elapsed.TotalSeconds)s" }
else { Stop-Job $job; Write-Host "[goal-e2e] TIMEOUT after ${TimeoutSec}s" }
$out = Receive-Job $job | Out-String
Remove-Job $job -Force
[System.IO.File]::WriteAllText($outFile, $out, (New-Object System.Text.UTF8Encoding($false)))
$exitCode = if ($out -match "EXITCODE:(-?\d+)") { $Matches[1] } else { "?" }
Write-Host "[goal-e2e] exit=$exitCode output saved ($([Math]::Round($out.Length/1kb,1))kb)"

# ── 断言 ──
$pass = 0; $fail = 0; $lines = @()
function Check([string]$name, [bool]$ok, [string]$note) {
  $script:pass++; $script:fail += (-not $ok); $script:lines += ("{0} {1}{2}" -f ($(if ($ok) {"PASS"} else {"FAIL"})), $name, $(if ($note) {" -> " + $note} else {""}))
  Write-Host ("{0} {1}" -f ($(if ($ok) {"PASS"} else {"FAIL"})), $name)
}

# A1 产物
$a1 = (Test-Path $probe) -and ((Get-Content $probe -Raw -ErrorAction SilentlyContinue) -match "GOAL-E2E-OK")
Check "A1 goal-probe.txt written with correct content" $a1

# A2 lab home 会话流 goal 生命周期（测试窗口内该 home 的最新会话 = 本 E2E 会话，无污染）
$newest = Get-ChildItem $sessionsRoot -Recurse -Filter "session.jsonl.zstd" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $cut } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
  $decoded = node -e "const zlib=require('node:zlib'),fs=require('node:fs');const buf=fs.readFileSync(process.argv[1]);const magic=Buffer.from([0x28,0xB5,0x2F,0xFD]);const offs=[];for(let i=0;(i=buf.indexOf(magic,i))!==-1;i+=4)offs.push(i);let out=Buffer.alloc(0);for(let k=0;k<offs.length;k++){const end=k+1<offs.length?offs[k+1]:buf.length;try{out=Buffer.concat([out,zlib.zstdDecompressSync(buf.subarray(offs[k],end))])}catch{}}for(const line of out.toString('utf8').split('\n')){try{const e=JSON.parse(line);const s=JSON.stringify(e);if(/goal/i.test(s))console.log((e.type||e.cat||'?')+' :: '+s.slice(0,200))}catch{}}" $newest.FullName
  $decoded | Out-File (Join-Path $base "goal-events.txt") -Encoding utf8
  $toolCreate = ($decoded | Where-Object { $_ -match "create_goal" }).Count
  $lifecycle = ($decoded | Where-Object { $_ -match "^\s*goal[/_-]" }).Count
  $completed = ($decoded | Where-Object { $_ -match "complete" }).Count
  Check "A2a create_goal tool event in stream" ($toolCreate -gt 0) "count=$toolCreate"
  Check "A2b goal/* lifecycle events in stream" ($lifecycle -gt 0) "count=$lifecycle"
  Check "A2c goal complete evidence in stream" ($completed -gt 0) "count=$completed"
  Write-Host "[goal-e2e] session=$($newest.FullName)"
} else {
  Check "A2 goal lifecycle in session stream" $false "no new session file under $sessionsRoot"
}

# A3 退出码
Check "A3 CLI exit code 0" ($exitCode -eq "0") "exit=$exitCode"

$lines += "RESULT pass=$pass fail=$fail"
$lines | Out-File $report -Encoding utf8
Write-Host "RESULT pass=$pass fail=$fail"
Write-Host "[goal-e2e] report=$report"
exit $(if ($fail -eq 0) { 0 } else { 1 })

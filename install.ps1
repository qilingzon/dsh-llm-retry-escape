# install.ps1 — one-command installer for dsh-llm-retry-escape
# Works on Windows PowerShell 5.1 and PowerShell 7+.
#
# Usage:
#   # Online (downloads from GitHub):
#   irm https://raw.githubusercontent.com/qilingzon/dsh-llm-retry-escape/main/install.ps1 | iex
#   # Local (from a cloned repo):
#   .\install.ps1
#   # Options:
#   .\install.ps1 -Profile desktop -DshHome "$env:USERPROFILE\.dsh"
#   .\install.ps1 -Source "C:\path\to\plugin\dir"     # offline install from a local dir
#
# Targets (both are required by DSH; the running Host serves the client half
# to BOTH the desktop app and the web UI from these files):
#   1. <DshHome>\plugins\dsh-llm-retry-escape\          (main home plugin source)
#   2. <DshHome>\profiles\<Profile>\node_modules\dsh-llm-retry-escape\  (profile mount)
#
# After install: RESTART DSH Desktop, then verify (see final output).

param(
    [string]$Profile = "desktop",
    [string]$DshHome = (Join-Path $env:USERPROFILE ".dsh"),
    [string]$Source = "",          # optional local plugin dir; empty = download from GitHub
    [string]$Repo = "qilingzon/dsh-llm-retry-escape",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$PluginId = "dsh-llm-retry-escape"
$Files = @("index.js", "client.js", "package.json", "cordis.patch.yml", "README.md")
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host "== dsh-llm-retry-escape installer ==" -ForegroundColor Cyan

# ── resolve source ──
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-escape-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$srcDir = $null
if ($Source -ne "") {
    if (-not (Test-Path $Source)) { throw "Source dir not found: $Source" }
    $srcDir = (Resolve-Path $Source).Path
    Write-Host "[1/4] source: local dir $srcDir"
} else {
    Write-Host "[1/4] source: downloading https://github.com/$Repo/archive/refs/heads/$Branch.zip ..."
    $zip = Join-Path $tmp "plugin.zip"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Where-Object Name -like "$Repo-*" | Select-Object -First 1
    if (-not $inner) { $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1 }
    $srcDir = $inner.FullName
}

foreach ($f in $Files) {
    if (-not (Test-Path (Join-Path $srcDir $f))) { throw "source is missing required file: $f" }
}

# ── targets ──
$target1 = Join-Path $DshHome "plugins\$PluginId"
$target2 = Join-Path $DshHome "profiles\$Profile\node_modules\$PluginId"
Write-Host "[2/4] targets:"
Write-Host "      desktop host : $target1"
Write-Host "      profile mount: $target2"

foreach ($t in @($target1, $target2)) {
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    foreach ($f in $Files) { Copy-Item (Join-Path $srcDir $f) $t -Force }
}

# ── verify (SHA256 at both targets) ──
Write-Host "[3/4] verify SHA256 at both targets:"
$ok = $true
foreach ($f in $Files) {
    $h0 = (Get-FileHash (Join-Path $srcDir $f) -Algorithm SHA256).Hash
    $h1 = (Get-FileHash (Join-Path $target1 $f) -Algorithm SHA256).Hash
    $h2 = (Get-FileHash (Join-Path $target2 $f) -Algorithm SHA256).Hash
    $same = ($h1 -eq $h0) -and ($h2 -eq $h0)
    if (-not $same) { $ok = $false }
    Write-Host ("      {0,-18} host={1} profile={2}" -f $f, $(if ($h1 -eq $h0) { "SAME" } else { "DIFF!" }), $(if ($h2 -eq $h0) { "SAME" } else { "DIFF!" }))
}
if (-not $ok) { throw "hash mismatch — install aborted (files left in place for inspection)" }

Write-Host "[4/4] installed." -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEPS" -ForegroundColor Cyan
Write-Host "  1. RESTART DSH Desktop (plugin + settings are read at startup only)."
Write-Host "  2. Verify per client type:"
Write-Host "     - Desktop app: open a session, plugin acts on request failures automatically;"
Write-Host "       check Settings -> plugin inventory shows dsh-llm-retry-escape."
Write-Host "     - Web UI (browser, same host): Settings -> 'Anti-stall history' panel renders"
Write-Host "       insight records (the client half client.js is served by the Host to web)."
Write-Host "  3. Optional env (set BEFORE Host start):"
Write-Host "       DSH_RETRY_ESCAPE_AFTER=5      (escape valve threshold, default 30)"
Write-Host "       DSH_RETRY_STRATEGY_AFTER=2    (strategy injection threshold)"
Write-Host "  4. Uninstall: run uninstall.ps1 from the repo (built-in llm-retry auto-restores)."

# cleanup temp download dir
if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

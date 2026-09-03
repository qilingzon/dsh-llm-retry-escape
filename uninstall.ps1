# uninstall.ps1 — remove dsh-llm-retry-escape from both DSH install points.
# The bundled cordis.patch.yml goes away with the folder, so the built-in
# @deepseek-ai/dsh-llm-retry is restored automatically (atomic rollback).
# Restart DSH Desktop afterwards.
#
# Usage: .\uninstall.ps1 [-Profile desktop] [-DshHome "$env:USERPROFILE\.dsh"]

param(
    [string]$Profile = "desktop",
    [string]$DshHome = (Join-Path $env:USERPROFILE ".dsh")
)
$ErrorActionPreference = "Stop"
$PluginId = "dsh-llm-retry-escape"

$target1 = Join-Path $DshHome "plugins\$PluginId"
$target2 = Join-Path $DshHome "profiles\$Profile\node_modules\$PluginId"

foreach ($t in @($target1, $target2)) {
    if (Test-Path $t) {
        Remove-Item $t -Recurse -Force
        Write-Host "removed: $t" -ForegroundColor Yellow
    } else {
        Write-Host "absent : $t"
    }
}
Write-Host ""
Write-Host "Built-in @deepseek-ai/dsh-llm-retry is restored automatically (bundle patch removed)." -ForegroundColor Green
Write-Host "RESTART DSH Desktop to apply."

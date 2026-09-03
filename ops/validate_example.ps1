# validate_example.ps1 — 负进度门禁的示例校验脚本（可作为模板）
# 约定：以 WorkDir 为 cwd、WorkDir 为第一个参数；退出码 0 = 校验通过，非 0 = 判负进度。
param([string]$Dir = ".")
$p = Join-Path $Dir "product.json"
if (-not (Test-Path $p)) { Write-Output "product.json absent - nothing to validate"; exit 0 }
try {
  $j = Get-Content $p -Raw | ConvertFrom-Json
  if (-not $j.ok) { Write-Output "product.json missing ok=true"; exit 1 }
  Write-Output "product.json OK"
  exit 0
} catch {
  Write-Output "product.json INVALID: $_"
  exit 1
}
# 运行测试：Go 单测 + 前端单测；加 -E2E 时再构建并跑 Playwright 冒烟测试。
param([switch]$E2E)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location "$root/server"
try { go test ./...; if ($LASTEXITCODE) { exit $LASTEXITCODE } } finally { Pop-Location }
pnpm -C "$root/web" test; if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($E2E) {
  & "$root/scripts/build.ps1"; if ($LASTEXITCODE) { exit $LASTEXITCODE }
  pnpm -C "$root/web" e2e; if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

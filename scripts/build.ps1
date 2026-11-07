# 构建单二进制：先构建前端（输出到 server/internal/webui/dist 并内嵌），再编译 Go。
# 用法：scripts/build.ps1 [-Out 输出路径]，默认 bin/lode.exe
param([string]$Out = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root 'bin/lode.exe' }
$version = (git -C $root describe --tags --always --dirty 2>$null); if (-not $version) { $version = 'dev' }
$commit = (git -C $root rev-parse --short HEAD 2>$null); if (-not $commit) { $commit = 'unknown' }

pnpm -C "$root/web" install --frozen-lockfile; if ($LASTEXITCODE) { exit $LASTEXITCODE }
pnpm -C "$root/web" build; if ($LASTEXITCODE) { exit $LASTEXITCODE }
Push-Location "$root/server"
try {
  $env:CGO_ENABLED = '0'
  go build -trimpath -ldflags "-s -w -X main.version=$version -X main.commit=$commit" -o $Out ./cmd/lode
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }
Write-Host "已构建 $Out"

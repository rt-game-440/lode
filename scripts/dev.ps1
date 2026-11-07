# 开发模式：Go 服务监听 127.0.0.1:8787（数据在 data-dev/），Vite 在 5173 并把 /api 代理过去。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $env:LODE_DATA_DIR) { $env:LODE_DATA_DIR = Join-Path $root 'data-dev' }
if (-not $env:LODE_ADDR) { $env:LODE_ADDR = '127.0.0.1:8787' }
$server = Start-Process -FilePath go -ArgumentList 'run', './cmd/lode', 'serve' -WorkingDirectory "$root/server" -NoNewWindow -PassThru
try {
  pnpm -C "$root/web" dev
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Get-Process lode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*go-build*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

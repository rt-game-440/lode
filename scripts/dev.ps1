# 开发模式：Go 服务监听 127.0.0.1:8787（数据在 data-dev/），Vite 在 5173 并把 /api 代理过去。
# 服务端日志写到 logs/<启动时间>.log。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $env:LODE_DATA_DIR) { $env:LODE_DATA_DIR = Join-Path $root 'data-dev' }
if (-not $env:LODE_ADDR) { $env:LODE_ADDR = '127.0.0.1:8787' }
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs ((Get-Date -Format 'yyyy-MM-dd HH-mm-ss') + '.log')
Write-Host "服务端日志：$log"
$server = Start-Process -FilePath go -ArgumentList 'run', './cmd/lode', 'serve' -WorkingDirectory "$root/server" -NoNewWindow -PassThru -RedirectStandardError $log
try {
  pnpm -C "$root/web" dev
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Get-Process lode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*go-build*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

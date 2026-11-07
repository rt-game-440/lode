# 交叉编译全部平台的发布二进制并生成 SHA256 校验文件，输出到 dist/。
# 用法：scripts/release.ps1 [-Version v0.1.0] [-SkipWeb]
param(
  [string]$Version = '',
  [switch]$SkipWeb
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Version) {
  $Version = (git -C $root describe --tags --always --dirty 2>$null)
  if (-not $Version) { $Version = 'dev' }
}
$commit = (git -C $root rev-parse --short HEAD 2>$null)
if (-not $commit) { $commit = 'unknown' }
$out = Join-Path $root 'dist'

if (-not $SkipWeb) {
  pnpm -C (Join-Path $root 'web') install --frozen-lockfile
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  pnpm -C (Join-Path $root 'web') build
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null

$targets = 'linux/amd64', 'linux/arm64', 'linux/arm/7', 'windows/amd64', 'darwin/amd64', 'darwin/arm64'
$saved = @{ GOOS = $env:GOOS; GOARCH = $env:GOARCH; GOARM = $env:GOARM; CGO_ENABLED = $env:CGO_ENABLED }
Push-Location (Join-Path $root 'server')
try {
  foreach ($t in $targets) {
    $parts = $t.Split('/')
    $os, $arch = $parts[0], $parts[1]
    $arm = if ($parts.Length -gt 2) { $parts[2] } else { '' }
    $name = "lode-$Version-$os-$arch"
    if ($arm) { $name += "v$arm" }
    if ($os -eq 'windows') { $name += '.exe' }
    Write-Host "构建 $name"
    $env:CGO_ENABLED = '0'; $env:GOOS = $os; $env:GOARCH = $arch; $env:GOARM = $arm
    go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$Version -X main.commit=$commit" -o (Join-Path $out $name) ./cmd/lode
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
  }
} finally {
  Pop-Location
  foreach ($k in $saved.Keys) { Set-Item "env:$k" -Value $saved[$k] -ErrorAction SilentlyContinue }
}

# 与 sha256sum 相同的格式：<小写哈希>  <文件名>
$lines = Get-ChildItem $out -Filter 'lode-*' | Sort-Object Name | ForEach-Object {
  "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)"
}
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS'), (($lines -join "`n") + "`n"))
Write-Host "已输出到 $out："
Get-ChildItem $out | Format-Table Name, Length

# 在本地跑 CI（.github/workflows/ci.yml）里的检查，结束时汇总每一步的结果和耗时。参数与 ci.sh 相同：
#   默认       同 CI 的“测试与构建”：go vet、go test、govulncheck、前端依赖、类型检查、单测、
#              pnpm audit、构建、Playwright 冒烟
#   -Quick     只跑 go vet、go test、前端依赖、类型检查和单测（不构建，不查漏洞）
#   -E2EAll    Playwright 跑全部规格，不只跑 smoke
#   -Bench     加跑性能基准（CI 的“性能基准”，1000 / 10000 篇）
#   -Release   加跑全平台交叉编译（CI“容器冒烟”任务里的发布脚本）
#   -Docker    加跑容器冒烟（需要 Docker，没有时跳过；隐含 -Release）
#   -All       等于 -Bench -Release -Docker
# Go 和前端两组检查并行。构建产物放在 bin/ci/，不覆盖可能正在运行的 bin/lode。
# 完整输出在 logs/ci/<时间>.log；有失败时退出码为 1。e2e 端口沿用 LODE_E2E_PORT（默认 18787）。
param(
  [switch]$Quick, [switch]$E2EAll, [switch]$Bench, [switch]$Release, [switch]$Docker, [switch]$All,
  # 内部使用：并行的一组检查在子进程里运行
  [string]$Lane = '', [string]$RunDir = ''
)
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'
$web = Join-Path $root 'web'
$ciBin = Join-Path $root ('bin/ci/lode' + ($IsWindows ? '.exe' : ''))
if ($All) { $Bench = $Release = $Docker = $true }
if ($Docker) { $Release = $true }

function Add-Result([string]$Id, [string]$Name, [string]$Status, [int]$Secs) {
  "$Id`t$Name`t$Status`t$Secs" | Out-File -LiteralPath (Join-Path $RunDir "results-$Lane") -Append -Encoding utf8
}

# 运行一步：输出写到 $RunDir/<id>.out，成功返回 $true
function Invoke-Step([string]$Id, [string]$Name, [scriptblock]$Body) {
  $out = Join-Path $RunDir "$Id.out"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $global:LASTEXITCODE = 0
  $ok = $true
  try {
    & $Body *>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath $out -Encoding utf8
    if ($global:LASTEXITCODE) { $ok = $false }
  } catch {
    "$_" | Out-File -LiteralPath $out -Append -Encoding utf8
    $ok = $false
  }
  $secs = [int]$sw.Elapsed.TotalSeconds
  Add-Result $Id $Name ($ok ? 'pass' : 'fail') $secs
  Write-Host ('{0} {1}（{2}s）' -f ($ok ? '✓' : '✗'), $Name, $secs)
  return $ok
}

function Skip-Step([string]$Id, [string]$Name, [string]$Reason) {
  Add-Result $Id $Name "skip:$Reason" 0
  Write-Host "- $Name（跳过：$Reason）"
}

if ($Lane -eq 'go') {
  Invoke-Step govet 'go vet' { go -C $server vet ./... } | Out-Null
  Invoke-Step gotest 'go test' { go -C $server test ./... } | Out-Null
  if ($Quick) { Skip-Step govuln govulncheck '-Quick' }
  else { Invoke-Step govuln govulncheck { go -C $server run golang.org/x/vuln/cmd/govulncheck@latest ./... } | Out-Null }
  exit 0
}
if ($Lane -eq 'web') {
  if (-not (Invoke-Step install '前端依赖' { pnpm -C $web install --frozen-lockfile })) {
    foreach ($s in @(@('typecheck', '类型检查'), @('unit', '前端单测'), @('audit', 'pnpm audit'))) { Skip-Step $s[0] $s[1] '前端依赖安装失败' }
    exit 0
  }
  Invoke-Step typecheck '类型检查' { pnpm -C $web typecheck } | Out-Null
  Invoke-Step unit '前端单测' { pnpm -C $web test } | Out-Null
  if ($Quick) { Skip-Step audit 'pnpm audit' '-Quick' }
  else { Invoke-Step audit 'pnpm audit' { pnpm -C $web audit --audit-level high } | Out-Null }
  exit 0
}

$started = [Diagnostics.Stopwatch]::StartNew()
$describe = git -C $root describe --tags --always --dirty 2>$null
New-Item -ItemType Directory -Force (Join-Path $root 'logs/ci') | Out-Null
$log = Join-Path $root ('logs/ci/' + (Get-Date -Format 'yyyy-MM-dd HH-mm-ss') + '.log')
$RunDir = Join-Path ([IO.Path]::GetTempPath()) "lode-ci-$PID"
New-Item -ItemType Directory -Force $RunDir | Out-Null
$Lane = 'main'
Write-Host "本地 CI：$describe，$(go env GOVERSION)（CI 用 1.26 最新补丁，标准库漏洞以此为准），日志 $log"

try {
  # 两组检查各起一个子进程并行跑
  $pwsh = (Get-Process -Id $PID).Path
  $common = "-NoProfile -File `"$PSCommandPath`" -RunDir `"$RunDir`"" + ($Quick ? ' -Quick' : '')
  $lanes = foreach ($l in 'go', 'web') { Start-Process $pwsh -ArgumentList "$common -Lane $l" -NoNewWindow -PassThru }
  $lanes | ForEach-Object { $_.WaitForExit() }

  if (-not $Quick) {
    if (-not (Invoke-Step build '构建' { & (Join-Path $root 'scripts/build.ps1') -Out $ciBin })) {
      Skip-Step e2e 'Playwright' '构建失败'
      if ($Bench) { Skip-Step bench '性能基准' '构建失败' }
      if ($Release) { Skip-Step release '交叉编译' '构建失败' }
      if ($Docker) { Skip-Step docker '容器冒烟' '构建失败' }
    } else {
      if (Invoke-Step pwinstall 'Playwright 浏览器' { pnpm -C $web exec playwright install chromium }) {
        $env:LODE_BIN = $ciBin
        if ($E2EAll) { Invoke-Step e2e 'Playwright 全部规格' { pnpm -C $web e2e } | Out-Null }
        else { Invoke-Step e2e 'Playwright 冒烟' { pnpm -C $web e2e smoke } | Out-Null }
        Remove-Item Env:LODE_BIN
      } else {
        Skip-Step e2e 'Playwright' '浏览器安装失败'
      }
      if ($Bench) { Invoke-Step bench '性能基准' { go -C $server run ./cmd/bench -bin $ciBin -n '1000,10000' } | Out-Null }
      if ($Release) {
        if (Invoke-Step release '交叉编译' { & (Join-Path $root 'scripts/release.ps1') -SkipWeb }) {
          if ($Docker) {
            $hasDocker = $false
            if (Get-Command docker -ErrorAction SilentlyContinue) { docker info *> $null; $hasDocker = $LASTEXITCODE -eq 0 }
            if ($hasDocker) {
              Invoke-Step docker '容器冒烟' { & (Join-Path $root 'scripts/docker-smoke.ps1') } | Out-Null
            } else {
              Skip-Step docker '容器冒烟' '本机没有可用的 Docker，看 CI 的“容器冒烟”任务'
            }
          }
        } elseif ($Docker) {
          Skip-Step docker '容器冒烟' '交叉编译失败'
        }
      }
    }
  }

  # 汇总：完整输出写日志，失败的步骤在终端打印末尾 40 行
  $failed = $false
  $summary = @()
  $body = @("本地 CI：$describe，$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')", '')
  foreach ($l in 'go', 'web', 'main') {
    $file = Join-Path $RunDir "results-$l"
    if (-not (Test-Path $file)) { continue }
    foreach ($line in Get-Content -LiteralPath $file -Encoding utf8) {
      $id, $name, $st, $secs = $line -split "`t"
      $word, $note = switch -Wildcard ($st) { 'pass' { '通过', "${secs}s" } 'fail' { '失败', "${secs}s" } default { '跳过', $st.Substring(5) } }
      $summary += "$word  $name（$note）"
      $out = Join-Path $RunDir "$id.out"
      $body += "==== ${name}：$word（$note）"
      if (Test-Path $out) { $body += Get-Content -LiteralPath $out -Encoding utf8 }
      $body += ''
      if ($st -eq 'fail') {
        $failed = $true
        Write-Host "`n---- $name 失败，输出末尾："
        Get-Content -LiteralPath $out -Encoding utf8 -Tail 40 | Write-Host
      }
    }
  }
  $summary = @("==== 汇总（$([int]$started.Elapsed.TotalSeconds)s）") + $summary
  ($body + $summary) | Out-File -LiteralPath $log -Encoding utf8
  $summary | Write-Host
  Write-Host "日志：$log"
  exit ($failed ? 1 : 0)
} finally {
  Remove-Item -Recurse -Force $RunDir -ErrorAction SilentlyContinue
}

# 测量空闲内存：生成 N 篇笔记 → 首次启动建立索引 → 重启并等待对账完成 → 空闲若干秒后读取常驻内存。
# 验收标准：1000 篇笔记、保持 -WebSockets 个 WebSocket 连接（默认 2）时空闲 RSS ≤ 50MB。需先运行 scripts/build.ps1。
# -Workspaces K（默认 0）：除默认空间外再建 K 个空间，各 N 篇笔记并全部打开后再测量；多空间时上限放宽到 80MB。
# -Bin 指定要测的二进制（默认 bin/lode.exe，对比旧版本时用）。
# -Out 指定时把结果以 UTF-8 写入该文件（例如 docs/evidence/stage-N/rss.txt）。
param([int]$N = 1000, [int]$Port = 18788, [int]$IdleSeconds = 15, [int]$WebSockets = 2, [int]$Workspaces = 0, [string]$Bin = '', [string]$Out = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = if ($Bin) { $Bin } else { Join-Path $root 'bin/lode.exe' }
if (-not (Test-Path $bin)) { throw '找不到 bin/lode.exe，请先运行 scripts/build.ps1' }
$data = Join-Path $root 'data-rss'
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
Push-Location (Join-Path $root 'server')
try {
  go run ./cmd/gennotes -dir (Join-Path $data 'vault') -n $N | Out-Host; if ($LASTEXITCODE) { exit $LASTEXITCODE }
  go build -o (Join-Path $data 'wsprobe.exe') ./cmd/wsprobe; if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally { Pop-Location }

$limit = if ($Workspaces -gt 0) { 80 } else { 50 }
$env:LODE_DATA_DIR = $data
$env:LODE_ADDR = "127.0.0.1:$Port"
$env:LODE_LOG_LEVEL = 'warn'
$base = "http://127.0.0.1:$Port"
# 只用于这个临时实例的随机密码
$password = 'rss-' + [guid]::NewGuid().ToString('N')

function Start-Lode {
  $p = Start-Process -FilePath $bin -ArgumentList 'serve' -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 100; $i++) {
    try { Invoke-RestMethod "$base/api/health" | Out-Null; return $p } catch { Start-Sleep -Milliseconds 100 }
  }
  throw '服务没有启动'
}

# 从进程启动开始计时，直到 /api/tree 里出现全部笔记
function Wait-Indexed($session, $sw, $prefix = '/api') {
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    $tree = Invoke-RestMethod "$base$prefix/tree" -WebSession $session
    if ($tree.notes.Count -ge $N) { return $sw.Elapsed.TotalSeconds }
    Start-Sleep -Milliseconds 200
  }
  throw '索引超时'
}

$body = @{ password = $password } | ConvertTo-Json
# 登录请求体写进文件交给 wsprobe，口令不出现在命令行里
$loginFile = Join-Path $data 'login.json'
[IO.File]::WriteAllText($loginFile, $body)
# 中途失败也要结束启动过的进程，避免占住端口
$p = $null
$probe = $null
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Lode
  Invoke-RestMethod "$base/api/auth/setup" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s | Out-Null
  $first = Wait-Indexed $s $sw
  $wsIds = @()
  for ($k = 1; $k -le $Workspaces; $k++) {
    $nb = @{ name = "rss-$k" } | ConvertTo-Json
    $wsIds += (Invoke-RestMethod "$base/api/workspaces" -Method Post -Body $nb -ContentType 'application/json' -WebSession $s).id
  }
  Stop-Process -Id $p.Id -Force
  $p.WaitForExit()
  $p = $null
  # 服务停止后往各空间的 vault 目录写笔记，下次启动时对账
  if ($wsIds.Count -gt 0) {
    Push-Location (Join-Path $root 'server')
    try {
      foreach ($id in $wsIds) {
        go run ./cmd/gennotes -dir (Join-Path $data "workspaces/$id/vault") -n $N | Out-Host; if ($LASTEXITCODE) { exit $LASTEXITCODE }
      }
    } finally { Pop-Location }
  }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Lode
  Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s2 | Out-Null
  $second = Wait-Indexed $s2 $sw
  # 逐个访问其他空间，触发打开（建监听、对账）
  foreach ($id in $wsIds) { $null = Wait-Indexed $s2 $sw "/api/w/$id" }
  # 保持 $WebSockets 个 WebSocket 连接，模拟在线设备
  $probeLog = Join-Path $data 'probe.log'
  $probe = Start-Process -FilePath (Join-Path $data 'wsprobe.exe') -ArgumentList '-base', $base, '-login', $loginFile, '-n', $WebSockets -PassThru -WindowStyle Hidden -RedirectStandardOutput $probeLog
  for ($i = 0; -not ((Test-Path $probeLog) -and (Get-Content $probeLog -Raw) -match 'WebSocket'); $i++) {
    if ($i -gt 100 -or $probe.HasExited) { throw 'WebSocket 连接失败' }
    Start-Sleep -Milliseconds 100
  }
  Start-Sleep -Seconds $IdleSeconds
  $proc = Get-Process -Id $p.Id
  $rss = [math]::Round($proc.WorkingSet64 / 1MB, 1)
  $private = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
} finally {
  foreach ($x in @($probe, $p)) { if ($x -and -not $x.HasExited) { Stop-Process -Id $x.Id -Force } }
}

$ok = $rss -le $limit
$lines = @(
  ("测量时间：{0}；系统：Windows；二进制：bin/lode.exe" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  ("口径：Windows WorkingSet（对应 Linux 的 RSS），启动后空闲 {0}s 读取；LODE_LOG_LEVEL=warn" -f $IdleSeconds)
  ("每个空间笔记数：{0}；工作空间：默认 + {1} 个（全部已打开）；保持的 WebSocket 连接（默认空间）：{2}" -f $N, $Workspaces, $WebSockets)
  ("首次启动到索引完成：{0:N2}s；重启到对账完成：{1:N2}s" -f $first, $second)
  ("空闲 {0}s 后 RSS（WorkingSet）：{1} MB；私有内存（已提交，含未驻留部分）：{2} MB" -f $IdleSeconds, $rss, $private)
  $(if ($ok) { "结果：通过（RSS ≤ ${limit}MB）" } else { "结果：超出 ${limit}MB" })
)
$lines | Write-Output
if ($Out) { $lines | Set-Content -Encoding utf8 -Path $Out }
if (-not $ok) { exit 1 }

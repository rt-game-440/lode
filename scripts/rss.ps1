# 测量空闲内存：生成 N 篇笔记 → 首次启动建立索引 → 重启并等待对账完成 → 空闲若干秒后读取常驻内存。
# 验收标准：1000 篇笔记时空闲 RSS ≤ 50MB。需先运行 scripts/build.ps1。
param([int]$N = 1000, [int]$Port = 18788, [int]$IdleSeconds = 15)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin/lode.exe'
if (-not (Test-Path $bin)) { throw '找不到 bin/lode.exe，请先运行 scripts/build.ps1' }
$data = Join-Path $root 'data-rss'
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
Push-Location (Join-Path $root 'server')
try { go run ./cmd/gennotes -dir (Join-Path $data 'vault') -n $N; if ($LASTEXITCODE) { exit $LASTEXITCODE } } finally { Pop-Location }

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
function Wait-Indexed($session, $sw) {
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    $tree = Invoke-RestMethod "$base/api/tree" -WebSession $session
    if ($tree.notes.Count -ge $N) { return $sw.Elapsed.TotalSeconds }
    Start-Sleep -Milliseconds 200
  }
  throw '索引超时'
}

$body = @{ password = $password } | ConvertTo-Json
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Lode
Invoke-RestMethod "$base/api/auth/setup" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s | Out-Null
$first = Wait-Indexed $s $sw
Stop-Process -Id $p.Id -Force
$p.WaitForExit()

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Lode
Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s2 | Out-Null
$second = Wait-Indexed $s2 $sw
Start-Sleep -Seconds $IdleSeconds
$proc = Get-Process -Id $p.Id
$rss = [math]::Round($proc.WorkingSet64 / 1MB, 1)
$private = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
Stop-Process -Id $p.Id -Force

Write-Host ("笔记数：{0}" -f $N)
Write-Host ("首次启动到索引完成：{0:N2}s；重启到对账完成：{1:N2}s" -f $first, $second)
Write-Host ("空闲 {0}s 后 RSS（WorkingSet）：{1} MB；私有内存：{2} MB" -f $IdleSeconds, $rss, $private)
if ($rss -le 50) { Write-Host '结果：通过（≤ 50MB）' } else { Write-Host '结果：超出 50MB'; exit 1 }

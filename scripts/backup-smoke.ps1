# 多工作空间备份 → 清空 → 恢复往返冒烟（#62），与 backup-smoke.sh 步骤一致。
# 用法：scripts/backup-smoke.ps1 [-Bin <lode 可执行文件>] [-Port 18799] [-Out docs/evidence/stage-7/backup-restore.txt]
# 需先运行 scripts/build.ps1；阶段 6 格式备份用系统自带的 tar 打包。
param([string]$Bin = '', [int]$Port = 18799, [string]$Out = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Bin) { $Bin = Join-Path $root 'bin/lode.exe' }
if (-not (Test-Path $Bin)) { throw "找不到 $Bin，请先运行 scripts/build.ps1" }
$log = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $log.Add($s); Write-Host $s }

$T = Join-Path ([IO.Path]::GetTempPath()) ("lode-bs-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $T | Out-Null
$env:LODE_DATA_DIR = Join-Path $T 'data'
$env:LODE_ADDR = "127.0.0.1:$Port"
$env:LODE_LOG_LEVEL = 'error'
$base = "http://127.0.0.1:$Port"
$ext = Join-Path $T 'obsidian'
New-Item -ItemType Directory -Force (Join-Path $ext '.obsidian'), (Join-Path $ext '子目录') | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Put([string]$path, [string]$text) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllText($path, $text, $utf8) }
Put (Join-Path $ext '.obsidian/app.json') '{"theme":"dark"}'
Put (Join-Path $ext '外部笔记.md') "# 外部笔记`n`n来自 Obsidian 库`n"
Put (Join-Path $ext '子目录/嵌套.md') "# 嵌套`n"

$script:proc = $null
function Lode { param([string[]]$a) $o = & $Bin @a 2>&1 | Out-String; $script:code = $LASTEXITCODE; return $o.TrimEnd() }
function Run { param([string[]]$a) Say ''; Say ('$ lode ' + ($a -join ' ')); $o = Lode $a; if ($o) { Say $o }; Say "[退出码 $script:code]" }
function Start-Lode {
  $script:proc = Start-Process -FilePath $Bin -ArgumentList 'serve' -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 50; $i++) { try { Invoke-RestMethod "$base/api/health" | Out-Null; return } catch { Start-Sleep -Milliseconds 200 } }
  throw '服务没起来'
}
function Stop-Lode { if ($script:proc) { Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue; $script:proc.WaitForExit(); $script:proc = $null; Start-Sleep 1 } }
function Open-All {
  $body = '{"password":"correct-horse-1"}'
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try { Invoke-WebRequest "$base/api/auth/setup" -Method Post -ContentType 'application/json' -Body $body -WebSession $s | Out-Null } catch {}
  Invoke-WebRequest "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body $body -WebSession $s | Out-Null
  foreach ($id in @('default', $script:inId, $script:exId)) {
    $r = Invoke-WebRequest "$base/api/w/$id/tree" -WebSession $s -SkipHttpErrorCheck
    Say "  打开 ${id}：$($r.StatusCode)"
  }
}
function Ids { (Lode @('workspace', 'list', '--json')) | ConvertFrom-Json }
function Files([string]$dir) { Get-ChildItem -Recurse -File $dir -Force | ForEach-Object { Say "  $($_.FullName)" } }

try {
  Say '== 1. 准备：默认空间、内置空间、外部空间各放笔记（服务启动一次让它们建索引）'
  Put (Join-Path $env:LODE_DATA_DIR 'vault/日记/默认.md') "# 默认笔记`n`n默认空间的内容`n"
  New-Item -ItemType Directory -Force (Join-Path $env:LODE_DATA_DIR 'trash') | Out-Null
  Start-Lode; Stop-Lode
  Run @('workspace', 'add', '内置空间')
  Run @('workspace', 'add', '外部库', '--dir', $ext)
  $script:inId = (Ids).workspaces | Where-Object { -not $_.external -and $_.id -ne 'default' } | Select-Object -First 1 -ExpandProperty id
  $script:exId = (Ids).workspaces | Where-Object { $_.external } | Select-Object -First 1 -ExpandProperty id
  Put (Join-Path $env:LODE_DATA_DIR "workspaces/$($script:inId)/vault/内置.md") "# 内置笔记`n`n内置空间的内容`n"
  Start-Lode; Open-All

  Say ''; Say '== 2. 服务运行中备份（完整 + 单空间），再恢复一次完整备份'
  $all = Join-Path $T 'all.tar.gz'; $one = Join-Path $T 'one.tar.gz'
  Run @('backup', $all)
  Run @('backup', $one, '--workspace', $script:inId)
  Run @('restore', $all, '-y')   # 服务运行中，应拒绝
  Stop-Lode
  Say ''; Say '== 3. 备份内容'
  tar -tzf $all | Where-Object { $_ -notmatch '/$' } | ForEach-Object { Say "  $_" }
  Say '-- 单空间备份'
  tar -tzf $one | Where-Object { $_ -notmatch '/$' } | ForEach-Object { Say "  $_" }

  Say ''; Say '== 4. 清空数据目录和外部目录'
  Remove-Item -Recurse -Force $env:LODE_DATA_DIR, $ext

  Say ''; Say '== 5. 外部原路径非空时拒绝恢复'
  New-Item -ItemType Directory -Force $ext | Out-Null; Put (Join-Path $ext '别人的文件.txt') '占位'
  Run @('restore', $all, '-y')
  if ($script:code -eq 0) { throw '外部目录非空时应拒绝恢复' }
  Remove-Item -Recurse -Force $ext

  Say ''; Say '== 6. 恢复（外部原路径空闲）'
  Run @('restore', $all, '-y')
  Say '-- 外部目录'; Files $ext
  Start-Lode; Open-All; Stop-Lode
  Run @('workspace', 'list')

  Say ''; Say '== 7. 恢复到新位置（--external-to）'
  Remove-Item -Recurse -Force $env:LODE_DATA_DIR, $ext
  $moved = Join-Path $T 'moved'
  Run @('restore', $all, '--external-to', $moved, '-y')
  Files $moved
  Start-Lode; Open-All; Stop-Lode
  Run @('workspace', 'list')

  Say ''; Say '== 8. 单空间备份恢复：改乱内置空间后只恢复它'
  Put (Join-Path $env:LODE_DATA_DIR "workspaces/$($script:inId)/vault/内置.md") "改乱了`n"
  Put (Join-Path $env:LODE_DATA_DIR 'vault/日记/之后新增.md') "# 恢复之后新增`n"
  Run @('restore', $one, '-y')
  Say '-- 内置笔记内容：'; Say (Get-Content -Raw (Join-Path $env:LODE_DATA_DIR "workspaces/$($script:inId)/vault/内置.md"))
  Say '-- 默认空间的新文件仍在：'; Get-ChildItem (Join-Path $env:LODE_DATA_DIR 'vault/日记') | ForEach-Object { Say "  $($_.Name)" }
  Start-Lode; Open-All; Stop-Lode
  Run @('workspace', 'list')

  Say ''; Say '== 9. 阶段 6 格式（format 1）备份'
  Remove-Item -Recurse -Force $env:LODE_DATA_DIR
  $seed = Join-Path $T 'seed'; $pack = Join-Path $T 'pack'
  $env:LODE_DATA_DIR = $seed; Start-Lode; Stop-Lode
  Put (Join-Path $pack 'vault/日记/旧版.md') "# 旧版`n"
  Put (Join-Path $pack 'lode-backup.json') '{"format":1,"version":"v0.6.0","db_version":6,"created_at":"2026-11-01T00:00:00Z"}'
  Copy-Item (Join-Path $seed 'app.db') (Join-Path $pack 'app.db')
  $stage6 = Join-Path $T 'stage6.tar.gz'
  tar -czf $stage6 -C $pack lode-backup.json app.db vault
  $env:LODE_DATA_DIR = Join-Path $T 'data'
  Run @('restore', $stage6, '-y')
  Files (Join-Path $env:LODE_DATA_DIR 'vault')
  Run @('workspace', 'list')
  if (-not (Test-Path (Join-Path $env:LODE_DATA_DIR 'vault/日记/旧版.md'))) { throw '阶段 6 备份没有恢复出笔记' }
  Say ''; Say '冒烟完成'
} finally {
  Stop-Lode
  if ($Out) { [IO.File]::WriteAllLines((Join-Path $root $Out), $log, $utf8) }
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
}

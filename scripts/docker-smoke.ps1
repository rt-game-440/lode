# 容器冒烟，参数与 docker-smoke.sh 相同；逻辑在 sh 版本里（需要 Git Bash 和 Docker）。
# 优先用 Git 自带的 bash：PATH 里的 bash 可能是 WSL 的 System32\bash.exe，它不认 Windows 路径。
$bash = 'bash'
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
  $gitBash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
  if (Test-Path $gitBash) { $bash = $gitBash }
}
& $bash ((Join-Path $PSScriptRoot 'docker-smoke.sh') -replace '\\', '/') @args
exit $LASTEXITCODE

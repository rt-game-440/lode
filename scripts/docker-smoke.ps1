# 容器冒烟，参数与 docker-smoke.sh 相同；逻辑在 sh 版本里（需要 Git Bash 或 WSL 的 bash 和 Docker）。
bash (Join-Path $PSScriptRoot 'docker-smoke.sh') @args
exit $LASTEXITCODE

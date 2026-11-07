#!/usr/bin/env sh
# 运行测试：Go 单测 + 前端单测；加 --e2e 时再构建并跑 Playwright 冒烟测试。
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
(cd "$root/server" && go test ./...)
pnpm -C "$root/web" test
if [ "${1:-}" = "--e2e" ]; then
  "$root/scripts/build.sh"
  pnpm -C "$root/web" e2e
fi

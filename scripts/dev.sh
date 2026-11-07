#!/usr/bin/env sh
# 开发模式：Go 服务监听 127.0.0.1:8787（数据在 data-dev/），Vite 在 5173 并把 /api 代理过去。
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
export LODE_DATA_DIR=${LODE_DATA_DIR:-"$root/data-dev"}
export LODE_ADDR=${LODE_ADDR:-127.0.0.1:8787}
(cd "$root/server" && go run ./cmd/lode serve) &
server_pid=$!
trap 'kill $server_pid 2>/dev/null' EXIT INT TERM
pnpm -C "$root/web" dev

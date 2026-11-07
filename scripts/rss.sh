#!/usr/bin/env sh
# 测量空闲内存：生成 N 篇笔记 → 首次启动建立索引 → 重启并等待对账完成 → 空闲若干秒后读取常驻内存。
# 验收标准：1000 篇笔记时空闲 RSS ≤ 50MB。需先运行 scripts/build.sh。
set -eu
N=${N:-1000}
PORT=${PORT:-18788}
IDLE=${IDLE:-15}
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/bin/lode$(go env GOEXE)"
[ -x "$bin" ] || { echo "找不到 $bin，请先运行 scripts/build.sh"; exit 1; }
data="$root/data-rss"
rm -rf "$data"
(cd "$root/server" && go run ./cmd/gennotes -dir "$data/vault" -n "$N") >&2

export LODE_DATA_DIR="$data" LODE_ADDR="127.0.0.1:$PORT" LODE_LOG_LEVEL=warn
base="http://127.0.0.1:$PORT"
jar="$data/cookies.txt"
# 临时实例的登录口令在运行时随机生成，写进请求体文件
rnd=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
login="$data/login.json"
printf '{"password":"rss-%s"}' "$rnd" >"$login"

start() {
  "$bin" serve &
  pid=$!
  i=0
  until curl -fs "$base/api/health" >/dev/null; do
    i=$((i + 1)); [ $i -gt 100 ] && { echo "服务没有启动"; exit 1; }
    sleep 0.1
  done
}

wait_indexed() {
  i=0
  while :; do
    count=$(curl -fs -b "$jar" "$base/api/tree" | grep -o '"id":' | wc -l)
    [ "$count" -ge "$N" ] && return
    i=$((i + 1)); [ $i -gt 600 ] && { echo "索引超时"; exit 1; }
    sleep 0.2
  done
}

rss_mb() {
  if [ -r "/proc/$1/status" ]; then
    awk '/VmRSS/ { printf "%.1f", $2 / 1024 }' "/proc/$1/status"
  else
    ps -o rss= -p "$1" | awk '{ printf "%.1f", $1 / 1024 }'
  fi
}

start
curl -fs -c "$jar" -H 'Content-Type: application/json' -d "@$login" "$base/api/auth/setup" >/dev/null
wait_indexed
kill "$pid"; wait "$pid" 2>/dev/null || true

start
curl -fs -c "$jar" -H 'Content-Type: application/json' -d "@$login" "$base/api/auth/login" >/dev/null
wait_indexed
sleep "$IDLE"
rss=$(rss_mb "$pid")
kill "$pid"; wait "$pid" 2>/dev/null || true

echo "笔记数：$N"
echo "空闲 ${IDLE}s 后 RSS：$rss MB"
if awk "BEGIN { exit !($rss <= 50) }"; then echo "结果：通过（≤ 50MB）"; else echo "结果：超出 50MB"; exit 1; fi

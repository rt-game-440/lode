#!/usr/bin/env sh
# 测量空闲内存：生成 N 篇笔记 → 首次启动建立索引 → 重启并等待对账完成 → 空闲若干秒后读取常驻内存。
# WORKSPACES=K（默认 0）：除默认空间外再建 K 个空间，各 N 篇笔记并全部打开后再测量，上限放宽到 80MB。
# 验收标准：1000 篇笔记、保持 2 个 WebSocket 连接（环境变量 WS）时空闲 RSS ≤ 50MB。需先运行 scripts/build.sh。
set -eu
N=${N:-1000}
PORT=${PORT:-18788}
IDLE=${IDLE:-15}
WS=${WS:-2}
WORKSPACES=${WORKSPACES:-0}
if [ "$WORKSPACES" -gt 0 ]; then LIMIT=80; else LIMIT=50; fi
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/bin/lode$(go env GOEXE)"
[ -x "$bin" ] || { echo "找不到 $bin，请先运行 scripts/build.sh"; exit 1; }
data="$root/data-rss"
rm -rf "$data"
(cd "$root/server" && go run ./cmd/gennotes -dir "$data/vault" -n "$N") >&2
probe="$data/wsprobe$(go env GOEXE)"
(cd "$root/server" && go build -o "$probe" ./cmd/wsprobe)

export LODE_DATA_DIR="$data" LODE_ADDR="127.0.0.1:$PORT" LODE_LOG_LEVEL=warn
base="http://127.0.0.1:$PORT"
jar="$data/cookies.txt"
# 临时实例的登录口令在运行时随机生成，写进请求体文件
rnd=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
login="$data/login.json"
printf '{"%s":"%s"}' password "$rnd" >"$login"

# 中途失败也要结束启动过的进程，避免占住端口
trap 'kill ${probe_pid:-} ${pid:-} 2>/dev/null || true' EXIT

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
  prefix=${1:-/api}
  i=0
  while :; do
    count=$(curl -fs -b "$jar" "$base$prefix/tree" | grep -o '"id":' | wc -l)
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
ws_ids=""
k=1
while [ "$k" -le "$WORKSPACES" ]; do
  id=$(curl -fs -b "$jar" -H 'Content-Type: application/json' -d "{\"name\":\"rss-$k\"}" "$base/api/workspaces" | sed -n 's/.*"id":"\([a-z0-9]*\)".*/\1/p')
  [ -n "$id" ] || { echo "创建工作空间失败"; exit 1; }
  ws_ids="$ws_ids $id"; k=$((k + 1))
done
kill "$pid"; wait "$pid" 2>/dev/null || true
# 服务停止后往各空间的 vault 目录写笔记，下次启动时对账
for id in $ws_ids; do
  (cd "$root/server" && go run ./cmd/gennotes -dir "$data/workspaces/$id/vault" -n "$N") >&2
done

start
curl -fs -c "$jar" -H 'Content-Type: application/json' -d "@$login" "$base/api/auth/login" >/dev/null
wait_indexed
# 逐个访问其他空间，触发打开（建监听、对账）
for id in $ws_ids; do wait_indexed "/api/w/$id"; done
# 保持 $WS 个 WebSocket 连接，模拟在线设备
"$probe" -base "$base" -login "$login" -n "$WS" >"$data/probe.log" &
probe_pid=$!
i=0
until grep -q "WebSocket" "$data/probe.log" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 100 ] && { echo "WebSocket 连接失败"; exit 1; }
  sleep 0.1
done
sleep "$IDLE"
rss=$(rss_mb "$pid")
kill "$probe_pid" 2>/dev/null || true
kill "$pid"; wait "$pid" 2>/dev/null || true

echo "口径：RSS（VmRSS / ps rss），LODE_LOG_LEVEL=warn"
echo "每个空间笔记数：$N；工作空间：默认 + $WORKSPACES 个，全部已打开"
echo "WebSocket 连接：$WS"
echo "空闲 ${IDLE}s 后 RSS：$rss MB"
if awk "BEGIN { exit !($rss <= $LIMIT) }"; then echo "结果：通过（≤ ${LIMIT}MB）"; else echo "结果：超出 ${LIMIT}MB"; exit 1; fi

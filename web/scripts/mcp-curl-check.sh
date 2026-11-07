#!/usr/bin/env bash
# 实测 docs/mcp.md 里的 curl 示例：起一个独立实例，建 token，依次执行文档中的命令并记录输出。
# 用法（先运行 scripts/build.sh）：bash web/scripts/mcp-curl-check.sh
# 输出：docs/evidence/stage-4/curl.txt。token 明文不写入任何文件或输出。
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
port="${LIVE_PORT:-18789}"
base="http://127.0.0.1:$port"
data="$root/data-live4-curl"
out="$root/docs/evidence/stage-4/curl.txt"
bin="$root/bin/lode"
[ -x "$bin.exe" ] && bin="$bin.exe"

rm -rf "$data" && mkdir -p "$data" "$(dirname "$out")"
LODE_ADDR="127.0.0.1:$port" LODE_DATA_DIR="$data" LODE_LOG_LEVEL=warn "$bin" serve &
pid=$!
trap 'kill $pid 2>/dev/null; for _ in $(seq 50); do rm -rf "$data" 2>/dev/null && break; sleep 0.2; done' EXIT
for _ in $(seq 100); do curl -sf "$base/api/health" >/dev/null && break; sleep 0.1; done

jar="$data/cookies"
pw="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
curl -sf -c "$jar" -H 'Content-Type: application/json' -d "{\"password\":\"$pw\"}" "$base/api/auth/setup" >/dev/null
curl -sf -b "$jar" -H 'Content-Type: application/json' -H "Origin: $base" \
  --data-binary @- "$base/api/notes" >/dev/null <<<'{"path":"收件箱.md","content":"# 收件箱\n\n- 试用 Lode 的 MCP\n"}'
LODE_TOKEN="$(curl -sf -b "$jar" -H 'Content-Type: application/json' -H "Origin: $base" \
  -d '{"name":"curl","scope":"read"}' "$base/api/tokens" | sed -E 's/.*"secret":"([^"]+)".*/\1/')"
export LODE_TOKEN
LODE_URL="$base/mcp"

run() { # 打印命令（token 用变量名表示）和输出
  echo "\$ $1"
  bash -c "$1" 2>&1 | sed "s/$LODE_TOKEN/<token>/g"
  echo
}
export -f run 2>/dev/null || true
export LODE_URL

{
  echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) docs/mcp.md 的 curl 示例实测（只读 token）"
  echo
  run 'curl -s "$LODE_URL" -H "Authorization: Bearer $LODE_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '"'"'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'"'"' | head -c 300'
  run 'curl -s "$LODE_URL" -H "Authorization: Bearer $LODE_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '"'"'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"MCP"}}}'"'"''
  run 'curl -s -o /dev/null -w "%{http_code}\n" "$LODE_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '"'"'{"jsonrpc":"2.0","id":3,"method":"tools/list"}'"'"''
} | tee "$out"

echo "证据文件中 lode_ 出现次数：$(grep -c lode_ "$out" || true)"

#!/usr/bin/env sh
# 构建单二进制：先构建前端（输出到 server/internal/webui/dist 并内嵌），再编译 Go。
# 用法：scripts/build.sh [输出路径]，默认 bin/lode（Windows 下为 bin/lode.exe）
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/bin/lode$(go env GOEXE)"}
# 相对路径按调用时的目录解析（下面会 cd 到 server 再编译）
case $out in /* | [A-Za-z]:*) ;; *) out="$PWD/$out" ;; esac
version=$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)

pnpm -C "$root/web" install --frozen-lockfile
pnpm -C "$root/web" build
cd "$root/server"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version -X main.commit=$commit" -o "$out" ./cmd/lode
echo "已构建 $out"

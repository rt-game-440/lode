#!/usr/bin/env sh
# 交叉编译全部平台的发布二进制并生成 SHA256 校验文件，输出到 dist/。
# 用法：scripts/release.sh [版本号]，默认取 git describe；设置 SKIP_WEB=1 跳过前端构建（已构建过时）。
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)}
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)
out="$root/dist"

if [ "${SKIP_WEB:-}" != "1" ]; then
  pnpm -C "$root/web" install --frozen-lockfile
  pnpm -C "$root/web" build
fi
rm -rf "$out"
mkdir -p "$out"

# 目标：系统/架构[/ARM 版本]
for target in linux/amd64 linux/arm64 linux/arm/7 windows/amd64 darwin/amd64 darwin/arm64; do
  os=$(echo "$target" | cut -d/ -f1)
  arch=$(echo "$target" | cut -d/ -f2)
  arm=$(echo "$target" | cut -d/ -s -f3)
  name="lode-$version-$os-$arch"
  [ -n "$arm" ] && name="${name}v$arm"
  [ "$os" = windows ] && name="$name.exe"
  echo "构建 $name"
  (cd "$root/server" && CGO_ENABLED=0 GOOS=$os GOARCH=$arch GOARM=$arm \
    go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version -X main.commit=$commit" -o "$out/$name" ./cmd/lode)
done

cd "$out"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum lode-* > SHA256SUMS
else
  shasum -a 256 lode-* > SHA256SUMS
fi
echo "已输出到 $out："
ls -l "$out"

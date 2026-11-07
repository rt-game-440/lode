#!/usr/bin/env bash
# 容器冒烟（CI 的 docker 任务调用，本地有 Docker 时也能运行）：
#   1. 构建镜像，docker compose up，等健康检查通过后跑 Playwright 的 container.spec；
#   2. 同一镜像加 --memory=256m 单独运行，再跑一遍；
#   3. 发布脚本产出的 linux/amd64 二进制在普通容器里启动，健康检查通过。
# 用法：scripts/docker-smoke.sh [dist 目录里 linux-amd64 二进制的路径]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
image=lode:smoke
project=lode-smoke

wait_healthy() { # 容器名
  for _ in $(seq 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo starting)
    [ "$status" = healthy ] && { echo "$1 健康检查通过"; return 0; }
    sleep 1
  done
  echo "$1 健康检查超时：$status"; docker logs "$1"; return 1
}

echo "== 构建镜像"
docker build -t "$image" --build-arg VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)" \
  --build-arg COMMIT="$(git rev-parse --short HEAD)" .
docker run --rm "$image" --version
docker image ls "$image" --format '镜像大小：{{.Size}}'

echo "== docker compose up"
cat > /tmp/compose.smoke.yml <<YAML
services:
  lode:
    image: $image
    build: !reset null
YAML
docker compose -p "$project" -f docker-compose.yml -f /tmp/compose.smoke.yml up -d --wait
cid=$(docker compose -p "$project" -f docker-compose.yml -f /tmp/compose.smoke.yml ps -q lode)
wait_healthy "$cid"
LODE_E2E_URL=http://127.0.0.1:8787 pnpm -C web e2e container
docker stats --no-stream --format '内存：{{.MemUsage}}（compose，mem_limit 256m）' "$cid"
docker compose -p "$project" -f docker-compose.yml -f /tmp/compose.smoke.yml down -v

echo "== --memory=256m"
docker run -d --name lode-mem --memory=256m -p 127.0.0.1:8788:8787 "$image" >/dev/null
trap 'docker rm -f lode-mem lode-bin >/dev/null 2>&1 || true' EXIT
wait_healthy lode-mem
LODE_E2E_URL=http://127.0.0.1:8788 pnpm -C web e2e container
docker stats --no-stream --format '内存：{{.MemUsage}}（--memory=256m）' lode-mem
[ "$(docker inspect -f '{{.State.OOMKilled}}' lode-mem)" = false ] && echo "没有被 OOM 终止"
docker rm -f lode-mem >/dev/null

bin=${1:-$(ls dist/lode-*-linux-amd64 2>/dev/null | head -1)}
if [ -n "$bin" ] && [ -f "$bin" ]; then
  bin=$(realpath "$bin")
  echo "== 发布二进制 $(basename "$bin") 在容器里运行"
  docker run -d --name lode-bin -v "$bin:/lode:ro" -e LODE_ADDR=0.0.0.0:8787 -e LODE_DATA_DIR=/tmp/data \
    --health-cmd '/lode healthcheck' --health-interval 2s --health-start-period 2s alpine:3 /lode serve >/dev/null
  wait_healthy lode-bin
  docker exec lode-bin /lode --version
  docker rm -f lode-bin >/dev/null
else
  echo "没有找到 linux-amd64 发布二进制，跳过第 3 步（先运行 scripts/release.sh）"
fi
echo "容器冒烟全部通过"

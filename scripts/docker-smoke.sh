#!/usr/bin/env bash
# 容器冒烟（CI 的 docker 任务调用，本地有 Docker 时也能运行）：
#   1. 构建镜像，docker compose up，等健康检查通过后跑 Playwright 的 container.spec；
#      然后在容器里备份 → 删除数据卷 → 恢复，确认原密码能登录、笔记还在；
#   2. 同一镜像加 --memory=256m 单独运行，再跑一遍 container.spec，确认没有被 OOM 终止；
#   3. 发布脚本产出的 linux/amd64 二进制在普通容器里启动，健康检查通过。
# 用法：scripts/docker-smoke.sh [dist 目录里 linux-amd64 二进制的路径]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
image=lode:smoke
project=lode-smoke
override=/tmp/compose.smoke.yml

compose() { docker compose -p "$project" -f docker-compose.yml -f "$override" "$@"; }
cleanup() {
  docker rm -f lode-mem lode-bin >/dev/null 2>&1 || true
  if [ -f "$override" ]; then compose down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

wait_healthy() { # 容器名
  for _ in $(seq 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo starting)
    [ "$status" = healthy ] && { echo "$1 健康检查通过"; return 0; }
    sleep 1
  done
  echo "$1 健康检查超时：$status"; docker logs "$1"; return 1
}

# 第 3 步需要发布脚本产出的 linux/amd64 二进制；缺少时直接失败，不静默跳过
bin=${1:-}
if [ -z "$bin" ]; then
  for f in dist/lode-*-linux-amd64; do
    if [ -f "$f" ]; then bin=$f; break; fi
  done
fi
if [ -z "$bin" ] || [ ! -f "$bin" ]; then
  echo "没有找到 linux-amd64 发布二进制，先运行 scripts/release.sh"; exit 1
fi
bin=$(realpath "$bin")

echo "== 构建镜像"
docker build -t "$image" --build-arg VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)" \
  --build-arg COMMIT="$(git rev-parse --short HEAD)" .
docker run --rm "$image" --version
docker image ls "$image" --format '镜像大小：{{.Size}}'

echo "== docker compose up"
cat > "$override" <<YAML
services:
  lode:
    image: $image
    build: !reset null
YAML
compose up -d --wait
cid=$(compose ps -q lode)
wait_healthy "$cid"
LODE_E2E_URL=http://127.0.0.1:8787 pnpm -C web e2e container
docker stats --no-stream --format '内存：{{.MemUsage}}（compose，mem_limit 256m）' "$cid"

echo "== 备份 → 删除数据卷 → 恢复"
compose exec -T lode lode backup /data/smoke.tar.gz
rm -f /tmp/lode-smoke.tar.gz
compose cp lode:/data/smoke.tar.gz /tmp/lode-smoke.tar.gz
chmod 644 /tmp/lode-smoke.tar.gz
compose down -v                       # 删除数据卷
compose up -d --wait                  # 全新的空数据卷
compose stop lode
compose run --rm --no-deps -v /tmp/lode-smoke.tar.gz:/backup.tar.gz:ro lode restore /backup.tar.gz -y
compose start lode
wait_healthy "$(compose ps -q lode)"
jar=$(mktemp)
curl -fsS -c "$jar" -H 'Content-Type: application/json' -d '{"password":"e2e-test-password"}' http://127.0.0.1:8787/api/auth/login >/dev/null
found=$(curl -fsS -b "$jar" -G --data-urlencode 'q=全文搜索' http://127.0.0.1:8787/api/search)
rm -f "$jar"
if ! echo "$found" | grep -q '容器冒烟'; then
  echo "恢复后找不到冒烟笔记：$found"; exit 1
fi
echo "恢复后用原密码登录，冒烟笔记还在"
compose down -v

echo "== --memory=256m"
docker run -d --name lode-mem --memory=256m -p 127.0.0.1:8788:8787 "$image" >/dev/null
wait_healthy lode-mem
LODE_E2E_URL=http://127.0.0.1:8788 pnpm -C web e2e container
docker stats --no-stream --format '内存：{{.MemUsage}}（--memory=256m）' lode-mem
if [ "$(docker inspect -f '{{.State.OOMKilled}}' lode-mem)" != false ]; then
  echo "容器被 OOM 终止"; exit 1
fi
echo "没有被 OOM 终止"
docker rm -f lode-mem >/dev/null

echo "== 发布二进制 $(basename "$bin") 在容器里运行"
docker run -d --name lode-bin -v "$bin:/lode:ro" -e LODE_ADDR=0.0.0.0:8787 -e LODE_DATA_DIR=/tmp/data \
  --health-cmd '/lode healthcheck' --health-interval 2s --health-start-period 2s alpine:3 /lode serve >/dev/null
wait_healthy lode-bin
docker exec lode-bin /lode --version
docker rm -f lode-bin >/dev/null
echo "容器冒烟全部通过"

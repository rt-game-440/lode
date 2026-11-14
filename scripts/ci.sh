#!/usr/bin/env sh
# 在本地跑 CI（.github/workflows/ci.yml）里的检查，结束时汇总每一步的结果和耗时。
# 用法：scripts/ci.sh [--quick] [--e2e-all] [--bench] [--release] [--docker] [--all]
#   默认       同 CI 的“测试与构建”：go vet、go test、govulncheck、前端依赖、类型检查、单测、
#              pnpm audit、构建、Playwright 冒烟
#   --quick    只跑 go vet、go test、前端依赖、类型检查和单测（不构建，不查漏洞）
#   --e2e-all  Playwright 跑全部规格，不只跑 smoke
#   --bench    加跑性能基准（CI 的“性能基准”，1000 / 10000 篇）
#   --release  加跑全平台交叉编译（CI“容器冒烟”任务里的发布脚本）
#   --docker   加跑容器冒烟（需要 Docker，没有时跳过；隐含 --release）
#   --all      等于 --bench --release --docker
# Go 和前端两组检查并行。构建产物放在 bin/ci/，不覆盖可能正在运行的 bin/lode。
# 完整输出在 logs/ci/<时间>.log；有失败时退出码为 1。e2e 端口沿用 LODE_E2E_PORT（默认 18787）。
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
server="$root/server"
web="$root/web"
cibin="$root/bin/ci/lode$(go env GOEXE)"

quick=0 e2eall=0 bench=0 release=0 docker=0
for a in "$@"; do
  case $a in
    --quick) quick=1 ;;
    --e2e-all) e2eall=1 ;;
    --bench) bench=1 ;;
    --release) release=1 ;;
    --docker) docker=1 release=1 ;;
    --all) bench=1 release=1 docker=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$a（--help 查看用法）" >&2; exit 2 ;;
  esac
done

mkdir -p "$root/logs/ci"
log="$root/logs/ci/$(date '+%Y-%m-%d %H-%M-%S').log"
run=$(mktemp -d)
trap 'rm -rf "$run"' EXIT
lane=main

# step <id> <名称> <命令...>：输出写到 $run/<id>.out，结果追加到本组的结果文件
step() {
  id=$1 name=$2
  shift 2
  t0=$(date +%s)
  if "$@" >"$run/$id.out" 2>&1; then st=pass mark='✓'; else st=fail mark='✗'; fi
  secs=$(($(date +%s) - t0))
  printf '%s\t%s\t%s\t%s\n' "$id" "$name" "$st" "$secs" >>"$run/results-$lane"
  printf '%s %s（%ss）\n' "$mark" "$name" "$secs"
  [ "$st" = pass ]
}

# skip <id> <名称> <原因>
skip() {
  printf '%s\t%s\tskip:%s\t0\n' "$1" "$2" "$3" >>"$run/results-$lane"
  printf -- '- %s（跳过：%s）\n' "$2" "$3"
}

lane_go() {
  step govet 'go vet' go -C "$server" vet ./...
  step gotest 'go test' go -C "$server" test ./...
  if [ $quick = 1 ]; then
    skip govuln govulncheck '--quick'
  else
    step govuln govulncheck go -C "$server" run golang.org/x/vuln/cmd/govulncheck@latest ./...
  fi
}

lane_web() {
  if ! step install '前端依赖' pnpm -C "$web" install --frozen-lockfile; then
    skip typecheck '类型检查' '前端依赖安装失败'
    skip unit '前端单测' '前端依赖安装失败'
    skip audit 'pnpm audit' '前端依赖安装失败'
    return
  fi
  step typecheck '类型检查' pnpm -C "$web" typecheck
  step unit '前端单测' pnpm -C "$web" test
  if [ $quick = 1 ]; then
    skip audit 'pnpm audit' '--quick'
  else
    step audit 'pnpm audit' pnpm -C "$web" audit --audit-level high
  fi
}

started=$(date +%s)
echo "本地 CI：$(git -C "$root" describe --tags --always --dirty 2>/dev/null)，$(go env GOVERSION)（CI 用 1.26 最新补丁，标准库漏洞以此为准），日志 $log"
(lane=go; lane_go) &
gopid=$!
(lane=web; lane_web) &
webpid=$!
wait $gopid $webpid

if [ $quick = 1 ]; then
  :
elif ! step build '构建' "$root/scripts/build.sh" "$cibin"; then
  skip e2e 'Playwright' '构建失败'
  [ $bench = 1 ] && skip bench '性能基准' '构建失败'
  [ $release = 1 ] && skip release '交叉编译' '构建失败'
  [ $docker = 1 ] && skip docker '容器冒烟' '构建失败'
else
  if step pwinstall 'Playwright 浏览器' pnpm -C "$web" exec playwright install chromium; then
    if [ $e2eall = 1 ]; then
      step e2e 'Playwright 全部规格' env LODE_BIN="$cibin" pnpm -C "$web" e2e
    else
      step e2e 'Playwright 冒烟' env LODE_BIN="$cibin" pnpm -C "$web" e2e smoke
    fi
  else
    skip e2e 'Playwright' '浏览器安装失败'
  fi
  [ $bench = 1 ] && step bench '性能基准' go -C "$server" run ./cmd/bench -bin "$cibin" -n 1000,10000
  if [ $release = 1 ]; then
    if step release '交叉编译' env SKIP_WEB=1 "$root/scripts/release.sh"; then
      if [ $docker = 1 ]; then
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
          step docker '容器冒烟' bash "$root/scripts/docker-smoke.sh"
        else
          skip docker '容器冒烟' '本机没有可用的 Docker，看 CI 的“容器冒烟”任务'
        fi
      fi
    elif [ $docker = 1 ]; then
      skip docker '容器冒烟' '交叉编译失败'
    fi
  fi
fi

# 汇总：完整输出写日志，失败的步骤在终端打印末尾 40 行
failed=0
{
  echo "本地 CI：$(git -C "$root" describe --tags --always --dirty 2>/dev/null)，$(date '+%Y-%m-%d %H:%M:%S')"
  echo
} >"$log"
summary=''
for f in go web main; do
  [ -f "$run/results-$f" ] || continue
  while IFS="$(printf '\t')" read -r id name st secs; do
    case $st in
      pass) word='通过' note="${secs}s" ;;
      fail) word='失败' note="${secs}s" failed=1 ;;
      *) word='跳过' note="${st#skip:}" ;;
    esac
    summary="$summary$word  $name（$note）
"
    {
      echo "==== $name：$word（$note）"
      [ -f "$run/$id.out" ] && cat "$run/$id.out"
      echo
    } >>"$log"
    if [ "$st" = fail ]; then
      echo
      echo "---- $name 失败，输出末尾："
      tail -n 40 "$run/$id.out"
    fi
  done <"$run/results-$f"
done

total=$(($(date +%s) - started))
{
  echo "==== 汇总（${total}s）"
  printf '%s' "$summary"
} | tee -a "$log"
echo "日志：$log"
exit $failed

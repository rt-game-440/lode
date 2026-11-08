#!/usr/bin/env bash
#!/usr/bin/env bash
# 多工作空间备份 → 清空 → 恢复往返冒烟（#62）：起真实服务，创建内置和外部工作空间，备份、清空、恢复。
# 用法：scripts/backup-smoke.sh [lode 可执行文件]（默认 bin/lode，Windows 为 bin/lode.exe；需先 scripts/build.sh）
# 端口用 PORT（默认 18799）；输出写到标准输出，证据存档：scripts/backup-smoke.sh > docs/evidence/stage-7/backup-restore.txt
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -ge 1 ]; then BIN=$1; elif [ -x "$root/bin/lode.exe" ]; then BIN="$root/bin/lode.exe"; else BIN="$root/bin/lode"; fi
[ -x "$BIN" ] || { echo "找不到 $BIN，请先运行 scripts/build.sh"; exit 1; }
PY=; for c in python3 python; do if command -v $c >/dev/null 2>&1 && $c -c "import sys" >/dev/null 2>&1; then PY=$c; break; fi; done
[ -n "$PY" ] || { echo "需要 python3"; exit 1; }
PORT=${PORT:-18799}
T=$(mktemp -d)
export LODE_DATA_DIR="$T/data"
export LODE_ADDR=127.0.0.1:$PORT
export LODE_LOG_LEVEL=error
if command -v cygpath >/dev/null 2>&1; then W() { cygpath -w "$1"; }; else W() { printf %s "$1"; }; fi
EXT="$T/obsidian"
mkdir -p "$EXT/.obsidian" "$EXT/子目录"
printf '{"theme":"dark"}' >"$EXT/.obsidian/app.json"
printf '# 外部笔记\n\n来自 Obsidian 库\n' >"$EXT/外部笔记.md"
printf '# 嵌套\n' >"$EXT/子目录/嵌套.md"

# 登录（首次设置密码），然后访问每个工作空间的笔记树，让服务打开它们并对账
open_all() {
  J="$T/jar"
  curl -s -c "$J" -X POST -H 'content-type: application/json' -d '{"password":"correct-horse-1"}' http://127.0.0.1:$PORT/api/auth/setup -o /dev/null
  curl -s -c "$J" -X POST -H 'content-type: application/json' -d '{"password":"correct-horse-1"}' http://127.0.0.1:$PORT/api/auth/login -o /dev/null
  for id in default $IN_ID $EX_ID; do
    printf '  打开 %s：' "$id"; curl -s -b "$J" -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/w/$id/tree"
  done
}
run() { echo; echo "\$ lode $*"; "$BIN" "$@" 2>&1; echo "[退出码 $?]"; }
start() { "$BIN" serve >"$T/serve.log" 2>&1 & SPID=$!; for i in $(seq 1 50); do curl -fs http://127.0.0.1:$PORT/api/health >/dev/null 2>&1 && return 0; sleep 0.2; done; echo "服务没起来"; cat "$T/serve.log"; return 1; }
stop() { if command -v taskkill >/dev/null 2>&1; then taskkill //F //PID "$(ps -p $SPID -o WINPID= 2>/dev/null | tr -d ' ')" >/dev/null 2>&1 || kill $SPID 2>/dev/null; else kill $SPID 2>/dev/null; fi; wait $SPID 2>/dev/null; sleep 1; }

echo "== 1. 准备：默认空间、内置空间、外部空间各放笔记（服务启动一次让它们建索引）"
mkdir -p "$LODE_DATA_DIR/vault/日记" "$LODE_DATA_DIR/trash"
printf '# 默认笔记\n\n默认空间的内容\n' >"$LODE_DATA_DIR/vault/日记/默认.md"
start || exit 1
stop
run workspace add 内置空间
run workspace add 外部库 --dir "$(W "$EXT")"
IN_ID=$("$BIN" workspace list --json | "$PY" -c "import sys,json; print([w['id'] for w in json.load(sys.stdin)['workspaces'] if not w['external'] and w['id']!='default'][0])")
printf '# 内置笔记\n\n内置空间的内容\n' >"$LODE_DATA_DIR/workspaces/$IN_ID/vault/内置.md"
EX_ID=$("$BIN" workspace list --json | "$PY" -c "import sys,json; print([w['id'] for w in json.load(sys.stdin)['workspaces'] if w['external']][0])")
start || exit 1
open_all
echo
echo "== 2. 服务运行中备份（完整 + 单空间）"
run backup "$(W "$T/all.tar.gz")"
run backup "$(W "$T/one.tar.gz")" --workspace "$IN_ID"
run restore "$(W "$T/all.tar.gz")" -y
stop
echo
echo "== 3. 备份内容"
tar -tzf "$T/all.tar.gz" | grep -v '/$' | sed 's/^/  /'
echo "-- 单空间备份"
tar -tzf "$T/one.tar.gz" | grep -v '/$' | sed 's/^/  /'
echo "-- 清单"
tar -xzOf "$T/all.tar.gz" lode-backup.json

echo
echo "== 4. 清空数据目录和外部目录"
rm -rf "$LODE_DATA_DIR" "$EXT"
ls "$T"

echo
echo "== 5. 外部原路径非空时拒绝恢复"
mkdir -p "$EXT" && echo 占位 >"$EXT/别人的文件.txt"
run restore "$(W "$T/all.tar.gz")" -y
ls "$LODE_DATA_DIR" 2>&1 | head -3
rm -rf "$EXT"

echo
echo "== 6. 恢复（外部原路径空闲）"
run restore "$(W "$T/all.tar.gz")" -y
echo "-- 外部目录"
find "$EXT" -type f | sed 's/^/  /'
start || exit 1
open_all
stop
run workspace list

echo
echo "== 7. 恢复到新位置（--external-to）"
rm -rf "$LODE_DATA_DIR" "$EXT"
run restore "$(W "$T/all.tar.gz")" --external-to "$(W "$T/moved")" -y
find "$T/moved" -type f | sed 's/^/  /'
start || exit 1
open_all
stop
run workspace list

echo
echo "== 8. 单空间备份恢复：改乱内置空间后只恢复它"
printf '改乱了\n' >"$LODE_DATA_DIR/workspaces/$IN_ID/vault/内置.md"
printf '# 恢复之后新增\n' >"$LODE_DATA_DIR/vault/日记/之后新增.md"
run restore "$(W "$T/one.tar.gz")" -y
echo "-- 内置笔记内容："; cat "$LODE_DATA_DIR/workspaces/$IN_ID/vault/内置.md"
echo "-- 默认空间的新文件仍在："; ls "$LODE_DATA_DIR/vault/日记"
echo "-- pre-restore："; ls "$LODE_DATA_DIR" | grep pre-restore
start || exit 1
open_all
stop
run workspace list

echo
echo "== 9. 阶段 6 格式（format 1）备份"
rm -rf "$LODE_DATA_DIR" "$T/old"
mkdir -p "$T/old/vault/日记"
echo "# 旧版" >"$T/old/vault/日记/旧版.md"
LODE_DATA_DIR="$T/seed" start || exit 1
stop
"$PY" - "$(W "$T")" <<'PY'
import sys, tarfile, io, json, os
t = sys.argv[1]
d = os.path.join(t, "seed")
with tarfile.open(os.path.join(t, "stage6.tar.gz"), "w:gz") as tf:
    m = json.dumps({"format": 1, "version": "v0.6.0", "db_version": 6, "created_at": "2026-11-01T00:00:00Z"}).encode()
    ti = tarfile.TarInfo("lode-backup.json"); ti.size = len(m); tf.addfile(ti, io.BytesIO(m))
    tf.add(os.path.join(d, "app.db"), "app.db")
    tf.add(os.path.join(t, "old", "vault"), "vault")
PY
run restore "$(W "$T/stage6.tar.gz")" -y
find "$LODE_DATA_DIR/vault" -type f | sed 's/^/  /'
run workspace list
if [ ! -f "$LODE_DATA_DIR/vault/日记/旧版.md" ]; then echo "失败：阶段 6 备份没有恢复出笔记"; exit 1; fi
echo
echo "冒烟完成，临时目录 $T"
rm -rf "$T"

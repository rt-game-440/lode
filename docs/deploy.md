# 部署、升级、备份与恢复

Lode 是一个 Go 二进制，数据全在一个目录里（`LODE_DATA_DIR`）：

```
data/
  app.db        SQLite 数据库：索引、设置、密码哈希、API token、助手配置和对话
  vault/        笔记（.md）和附件，真相源
  trash/        回收站
  backups/      升级迁移前自动备份的数据库（保留最近 5 份）
```

空闲内存约 22MB（1000 和 10000 篇笔记的实测，见 [benchmark.md](benchmark.md)），512MB 内存的机器足够。下面三种部署方式任选一种。

## 1. VPS（Docker + Caddy 自动 HTTPS）

前提：一台能从公网访问 80 和 443 端口的 Linux 服务器，装好 Docker（含 compose 插件 2.24 以上），一个解析到这台服务器的域名。

```bash
git clone https://github.com/rt-game-440/lode.git && cd lode
echo "LODE_SECRET_KEY=$(openssl rand -base64 32)" > .env
echo "LODE_DOMAIN=notes.example.com" >> .env
docker compose -f docker-compose.yml -f deploy/compose.caddy.yml up -d
```

- 打开 `https://notes.example.com`，设置登录密码。Caddy 首次申请证书可能需要几十秒。
- `.env` 要妥善保存（尤其是 `LODE_SECRET_KEY`），不要提交到仓库；仓库的 `.gitignore` 已忽略它。
- 叠加 Caddy 后 Lode 不再映射到宿主机端口，只能经 Caddy 访问。
- 内存：`docker-compose.yml` 给 Lode 设了 `mem_limit: 256m` 和 `GOMEMLIMIT=100MiB`，可以在 `.env` 里覆盖 `GOMEMLIMIT`。
- 查看日志：`docker compose logs -f lode`。

### 用二进制和 systemd

不想用 Docker 时：

```bash
# 下载对应平台的二进制和 SHA256SUMS，校验
sha256sum -c SHA256SUMS --ignore-missing
sudo useradd --system --home /var/lib/lode --shell /usr/sbin/nologin lode
sudo install -m 755 lode-v0.1.0-linux-amd64 /usr/local/bin/lode
sudo install -d -o lode -g lode -m 700 /var/lib/lode
sudo install -m 600 /dev/null /etc/lode.env
echo "LODE_SECRET_KEY=$(openssl rand -base64 32)" | sudo tee /etc/lode.env > /dev/null
sudo cp deploy/lode.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lode
```

服务监听 `127.0.0.1:8787`。在主机上装 Caddy，把 `deploy/Caddyfile` 里的 `{$LODE_DOMAIN}` 换成你的域名、`{$LODE_UPSTREAM}` 换成 `127.0.0.1:8787`，放到 `/etc/caddy/Caddyfile` 后 `sudo systemctl reload caddy`。Caddy 在本机，不需要设置 `LODE_TRUSTED_PROXIES`。

用 Nginx 等其他反向代理时注意：

- WebSocket：`/api/ws` 需要 `Upgrade` / `Connection` 头（Nginx：`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），读超时不要短于 60 秒。
- SSE：助手的事件流 `/api/agent/chats/{id}/stream` 不能缓冲（Nginx：`proxy_buffering off;`）。
- 请求体上限至少 32MB（附件 20MB、助手带图片的消息 32MB）。
- 传 `X-Forwarded-For` 和 `X-Forwarded-Proto`；代理不在本机时把它的地址加进 `LODE_TRUSTED_PROXIES`，否则会话 cookie 不会带 `Secure`、登录限速会把所有人当成同一个 IP。

## 2. NAS（群晖、威联通、Unraid 等）

在 NAS 的 Docker / Container Manager 里用镜像 `ghcr.io/rt-game-440/lode:latest`（`v0.1.0` 发布后可用；之前可以在电脑上 `docker build -t lode .` 再导入），或者把 `docker-compose.yml` 作为“项目”导入。

- 端口：容器内 8787。只在局域网用时映射成 `8787:8787`（compose 里改 `ports`）。
- 数据：把 `/data` 挂到 NAS 的共享文件夹，例如 `/volume1/docker/lode:/data`。镜像以 uid 65532 运行，先在 NAS 的终端执行 `sudo chown -R 65532:65532 /volume1/docker/lode`，否则启动时会报权限错误。
- 环境变量：`LODE_SECRET_KEY`（用于助手）、`GOMEMLIMIT`。
- 笔记就在挂载目录的 `vault/` 下，可以用 NAS 自带的同步或快照功能额外保护；用其他工具直接改这些 `.md` 文件，Lode 会自动同步。
- 手机安装 PWA 需要 HTTPS：用 NAS 自带的反向代理（群晖“登录门户 → 高级 → 反向代理服务器”，记得在“自定义标题”里加 WebSocket）配合证书，或者在局域网内参考 [dev-https.md](dev-https.md)。NAS 的反向代理不在容器的本机回环上，要把它的地址（通常是 Docker 网桥网关，如 `172.17.0.1`）加进 `LODE_TRUSTED_PROXIES`。

## 3. 树莓派

- 64 位系统（Raspberry Pi OS 64-bit，树莓派 3/4/5）用 `linux-arm64`；32 位系统用 `linux-armv7`。`uname -m` 输出 `aarch64` 是 64 位，`armv7l` 是 32 位。
- Docker 和二进制两种方式都可以，步骤和 VPS 相同；镜像是多架构的，会自动选对。
- 数据目录尽量放在 U 盘或 SSD 上，少写 SD 卡：二进制部署改 `LODE_DATA_DIR`，Docker 部署把 `/data` 挂到外接盘。
- 首次导入大量笔记时建立索引比 PC 慢（PC 上 10000 篇约 6 秒，见 [benchmark.md](benchmark.md)），之后启动只比对文件的修改时间和大小。

## 升级

数据库迁移在启动时自动执行。有待执行的迁移时，会先把数据库复制到 `backups/app-v<旧版本>-<时间>.db`。保险起见，升级前再做一次完整备份。

Docker：

```bash
docker compose exec lode lode backup /data/before-upgrade.tar.gz
git pull                      # 更新 compose 文件和 Caddyfile
docker compose pull && docker compose up -d
docker compose exec lode lode --version
```

二进制：

```bash
sudo -u lode env LODE_DATA_DIR=/var/lib/lode lode backup /var/lib/lode/before-upgrade.tar.gz
sudo install -m 755 lode-v0.2.0-linux-amd64 /usr/local/bin/lode
sudo systemctl restart lode
lode --version
```

降级不受支持：新版本迁移过的数据库，旧版本可能打不开。需要回退时，用升级前的备份恢复。

## 备份

`lode backup` 用 SQLite 的 `VACUUM INTO` 在线复制数据库，再把 `vault/` 和 `trash/` 一起打包成一个 tar.gz。服务运行中也可以执行，不影响使用。

```bash
# 二进制
sudo -u lode env LODE_DATA_DIR=/var/lib/lode lode backup /var/lib/lode/lode-$(date +%F).tar.gz

# Docker：写到卷里，再复制出来
docker compose exec lode lode backup /data/lode-$(date +%F).tar.gz
docker compose cp lode:/data/lode-$(date +%F).tar.gz .
```

运行镜像是 distroless，没有 shell 和 `rm`。备份文件留在卷里不影响服务（它不会被再次打包），也可以在宿主机上清理：`docker run --rm -v <项目名>_lode-data:/data alpine rm /data/lode-<日期>.tar.gz`（项目名默认是仓库目录名，完整卷名用 `docker volume ls` 查看）。

备份包含：全部笔记和附件、回收站、数据库里的设置、登录密码哈希、API token（哈希）、助手的供应商配置（API key 以 `LODE_SECRET_KEY` 加密保存）和对话记录。

**`LODE_SECRET_KEY` 不在备份里**，要单独保存。恢复到新机器时用同一个主密钥，否则助手的 API key 需要重新填写。

定时备份可以用 root 的 cron，例如每天凌晨备份到 `/srv/backup`（要对 `lode` 用户可写）并保留 14 天：

```cron
0 3 * * * sudo -u lode env LODE_DATA_DIR=/var/lib/lode /usr/local/bin/lode backup /srv/backup/lode-$(date +\%F).tar.gz && find /srv/backup -name 'lode-*.tar.gz' -mtime +14 -delete
```

## 恢复

**风险提示**：恢复会用备份替换当前的全部数据（数据库、笔记、附件、回收站）。原有数据不会删除，而是移到数据目录下的 `pre-restore-<时间>/`，确认无误后再手动删除。恢复必须在服务停止时进行，`lode restore` 检测到服务在运行会拒绝执行。

二进制：

```bash
sudo systemctl stop lode
sudo -u lode env LODE_DATA_DIR=/var/lib/lode lode restore /srv/backup/lode-2026-11-07.tar.gz
sudo systemctl start lode
```

`restore` 会显示风险提示并要求输入 `yes`；脚本里使用时加 `-y`。

Docker：

```bash
docker compose stop lode
docker compose run --rm --no-deps -v "$PWD:/backup:ro" lode restore /backup/lode-2026-11-07.tar.gz -y
docker compose start lode
```

恢复会先校验备份（解包到临时目录并检查数据库完整性），备份损坏时不改动现有数据。恢复后用原来的密码登录。

## 忘记密码

```bash
sudo -u lode env LODE_DATA_DIR=/var/lib/lode lode reset-password      # 二进制，按提示输入两次
docker compose exec lode lode reset-password                           # Docker
```

重置后所有已登录的设备需要重新登录。

## 健康检查与日志

- `GET /api/health` 返回 `{"status":"ok","version":…}`；`lode healthcheck` 请求它，镜像的 `HEALTHCHECK` 用的就是这个命令。
- 日志写到标准错误，级别由 `LODE_LOG_LEVEL` 控制（`debug`、`info`、`warn`、`error`）。Docker 用 `docker compose logs`，systemd 用 `journalctl -u lode`。

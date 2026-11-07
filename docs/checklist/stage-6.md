# 阶段 6 人工验收清单

准备：

- 一台自己的 Linux 服务器（512MB 内存以上的 VPS、NAS 或树莓派均可），装好 Docker 和 compose 插件（2.24 以上）。
- 一个域名，A/AAAA 记录指向这台服务器；80 和 443 端口能从公网访问。
- 一部手机。

说明：`v0.1.0` 还没有发版，ghcr.io 上暂时没有镜像。`docker compose up` 拉取失败时会自动在服务器上构建（几分钟，需要约 1GB 内存；512MB 的机器可以先在电脑上 `docker build -t ghcr.io/rt-game-440/lode:latest .`，再用 `docker save | ssh 服务器 docker load` 传过去）。

- [ ] **1. 按 README 从零部署**
  - 操作：
    1. 只看 README 的“快速开始 → Docker”和“HTTPS 与反向代理”两节，在服务器上克隆仓库、生成 `.env`。
    2. 在 `.env` 里加上 `LODE_DOMAIN=<你的域名>`，执行 `docker compose -f docker-compose.yml -f deploy/compose.caddy.yml up -d`。
    3. `docker compose ps` 查看状态。
  - 预期效果：两个容器都在运行，`lode` 显示 `healthy`；整个过程不需要查 README 以外的资料，遇到不清楚的地方请记下来。
  - 用户反馈：

- [ ] **2. HTTPS**
  - 操作：在电脑浏览器打开 `https://<你的域名>`，完成首次设置密码，新建一篇笔记；查看地址栏的证书信息。
  - 预期效果：证书有效（Let's Encrypt 或 ZeroSSL 签发），没有安全警告；`http://` 自动跳转到 `https://`；登录后刷新页面仍保持登录。
  - 用户反馈：

- [ ] **3. 手机安装 PWA 并同步**
  - 操作：
    1. 手机浏览器打开同一个地址并登录。iPhone 用 Safari → 分享 → 添加到主屏幕；Android 用 Chrome → 菜单 → 安装应用。
    2. 从主屏幕图标打开，编辑第 2 步那篇笔记；同时在电脑上看着这篇笔记。
  - 预期效果：以独立窗口打开（没有浏览器地址栏），图标和启动画面正常；手机上的修改一两秒内出现在电脑上。
  - 用户反馈：

- [ ] **4. 备份与恢复**
  - 操作（按 [docs/deploy.md](../deploy.md) 的“备份”和“恢复”两节）：
    1. 新建几篇笔记，其中一篇粘贴一张图片；在“设置”里创建一个 API token；如果配置了助手，也保存一个供应商。
    2. 备份：`docker compose exec lode lode backup /data/test.tar.gz`，再 `docker compose cp lode:/data/test.tar.gz .`。
    3. 删除一篇笔记并清空回收站，再修改另一篇。
    4. 恢复：`docker compose stop lode`，`docker compose run --rm --no-deps -v "$PWD:/backup:ro" lode restore /backup/test.tar.gz -y`，`docker compose start lode`。
  - 预期效果：恢复后用原密码能登录；被删的笔记回来了，被改的笔记回到备份时的内容，图片正常显示；API token 还在且能用（`claude mcp list` 或 curl 访问 `/mcp`）；助手的供应商还在，不需要重新填 key。恢复时命令行提示原数据已移到 `pre-restore-<时间>/`。
  - 用户反馈：

- [ ] **5. 运维细节（可选）**
  - 操作：
    1. 服务运行中执行 `docker compose run --rm --no-deps lode restore /data/test.tar.gz -y`。
    2. `docker compose exec lode lode reset-password`，输入新密码。
    3. `docker stats --no-stream`，看 `lode` 的内存。
  - 预期效果：第 1 步被拒绝（提示服务正在运行，需要先停止）；第 2 步之后旧会话失效，新密码可以登录；空闲内存在 50MB 左右以内。
  - 用户反馈：

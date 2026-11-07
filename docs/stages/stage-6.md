# 阶段 6/6：发布、部署与运维

依赖：阶段 5（#5，间接依赖全部前序阶段）。开始前按 `AGENTS.md` 的"开始一个阶段"执行，共同约定见 `docs/SPEC.md`。分支名 `stage-6-release`。

目标：别人按 README 就能在 512MB 内存的 VPS、NAS 或树莓派上部署起来，并能备份、恢复、升级。

## 范围内

### 构建与 CI

- `scripts/release`（ps1 和 sh）交叉编译 linux amd64 / arm64 / armv7、windows amd64、darwin amd64 / arm64；用 `-ldflags` 注入版本号和 commit，`notevault --version` 能输出。
- GitHub Actions：
  - CI：PR 和 push 到 main 时跑 `go test`、`go vet`、前端测试与构建、Playwright 冒烟；
  - Release：推送 `v*` tag 时构建全平台二进制和 SHA256 校验文件并上传到 GitHub Release，构建多架构 Docker 镜像推送到 `ghcr.io`。
- 本阶段只写好 Release 流程，不实际打 tag 发版（发版要先问）。

### 容器与部署

- Dockerfile 多阶段构建：node 构建前端 → go 构建 → 精简运行镜像（distroless static 或 alpine）；非 root 用户；`/data` 卷；用 `/api/health` 做 HEALTHCHECK；默认设置 `GOMEMLIMIT`（约 100MiB，可覆盖）。
- 示例：`docker-compose.yml`、Caddy 反向代理（自动 HTTPS）、systemd unit。
- 安全响应头：CSP、`X-Content-Type-Options`、`Referrer-Policy`；在 HTTPS 下会话 cookie 加 `Secure`。

### 运维子命令

- `notevault backup <输出文件>`：用 SQLite 在线备份加 vault 打包成一个 tar.gz，服务运行中也能执行。
- `notevault restore <备份文件>`：服务停止时恢复，写清风险提示。
- `notevault reset-password`：在服务器上重置登录密码。
- 启动时自动执行数据库迁移；迁移前自动备份数据库文件。
- 日志级别用环境变量 `NOTEVAULT_LOG_LEVEL` 配置。

### 性能基准

- 脚本生成 1000 和 10000 篇笔记，记录启动后空闲 RSS、全量索引耗时、搜索延迟 p95、保存延迟 p95，写入 `docs/benchmark.md`，注明测试机配置。

### 文档

- README：一句话介绍、截图、特性列表、快速开始（Docker 一条命令、二进制、反向代理、PWA 安装、MCP 接入、Agent 配置的入口）、环境变量表。
- `docs/deploy.md`：VPS、NAS、树莓派的部署与升级步骤；备份和恢复。
- `CHANGELOG.md`：写 `v0.1.0` 的条目。

## 范围外

多用户、云托管服务、桌面或移动端原生壳、自动更新。

## 保持不变

已有功能和 API 不变；已有测试继续通过。

## 验收标准

1. 本阶段的 PR 上 CI 全绿。
2. 本地运行 release 脚本产出全部平台的二进制；linux/amd64 二进制在容器里启动后健康检查通过。
3. `docker compose up` 后对容器跑 Playwright 冒烟通过；加上 `--memory=256m` 限制后同样通过。
4. 备份 → 删除数据目录 → 恢复后，笔记、附件、设置、供应商配置、API token 都完整。
5. `govulncheck ./...` 没有可达漏洞；`pnpm audit` 没有 high / critical，或逐条列出并说明原因。
6. `docs/benchmark.md` 有数据：1000 篇空闲 RSS ≤ 50MB，10000 篇约 ≤ 120MB；超出就报告主要占用来源和优化建议。
7. 写入 `docs/checklist/stage-6.md`：在你自己的服务器上按 README 从零部署、配置 HTTPS、手机安装 PWA、做一次备份和恢复。

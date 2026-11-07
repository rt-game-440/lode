# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.1.0] - 未发布

第一个版本。

### 笔记

- 笔记是数据目录 `vault/` 下的普通 Markdown 文件；外部修改、新增、移动、删除会被监听并同步进索引，启动时自动对账。
- CodeMirror 编辑器、实时预览、自动保存；文件夹树、新建、重命名、移动、删除（进回收站，可还原）。
- `[[双向链接]]`（重命名时自动更新引用）、反链面板、`#标签`、支持中文的全文搜索（SQLite FTS5 trigram）、快速切换器。
- 粘贴或拖入图片作为附件。

### 同步与 PWA

- WebSocket 实时推送变更；多设备同时编辑时自动三方合并，无法合并时生成冲突副本，不丢数据。
- 离线可读写，联网后自动同步；可安装为 PWA。

### 界面

- Apple 风格的桌面和移动端界面：深色模式、减弱动态效果、半透明材质；移动端左缘返回、抽屉拖拽、编辑工具栏等手势。

### MCP 与 API token

- 设置页创建只读或读写的 API token（只保存哈希）。
- `/mcp` 提供 Streamable HTTP 的 MCP 服务：搜索、阅读、列出、新建、修改、移动、删除笔记等工具。

### Agent 助手

- 接入 OpenAI 兼容、Anthropic、Gemini 三类供应商的多个模型；每个模型单独设置上下文窗口、最大输出、推理强度和输入模态（图片）。
- 助手能调用笔记工具，修改笔记前需要确认；对话持久化，切换设备后可以继续，生成过程中断线重连不丢事件。
- 上下文超出窗口时，用模型对早期对话做摘要（带缓存，失败时退回启发式摘要）。
- 供应商 API key 用 `LODE_SECRET_KEY` 加密保存，不出现在日志和接口响应里。

### 部署与运维

- 单个 Go 二进制（内嵌前端，无 CGO），Linux amd64 / arm64 / armv7、Windows amd64、macOS amd64 / arm64；`lode --version` 显示版本和 commit。
- 多架构 Docker 镜像（distroless、非 root、`HEALTHCHECK`、默认 `GOMEMLIMIT=100MiB`）；`docker-compose.yml`、Caddy 自动 HTTPS、systemd unit 示例。
- 运维子命令：`lode backup`（在线备份成一个 tar.gz）、`lode restore`（停服恢复，原数据保留）、`lode reset-password`、`lode healthcheck`。
- 启动时自动迁移数据库，迁移前自动备份；数据目录加文件锁，防止两个进程同时使用。
- 安全响应头（CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`）；HTTPS 下会话 cookie 带 `Secure`；登录失败限速。
- 空闲内存约 22MB（Linux，1000 和 10000 篇笔记），见 `docs/benchmark.md`；性能基准工具 `server/cmd/bench`。

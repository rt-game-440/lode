# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.1.0] - 2026-11-08

第一个版本。

### 笔记

- 笔记是数据目录 `vault/` 下的普通 Markdown 文件；外部修改、新增、移动、删除会被监听并同步进索引，启动时自动对账。
- CodeMirror 编辑器、实时预览、自动保存；文件夹树、新建、重命名、移动、删除（进回收站，可还原）。
- 桌面端常驻格式顶栏（可在设置里隐藏），常用格式都有快捷键；移动端键盘上方的格式快捷栏。
- 每篇笔记可以单独选择页宽（窄 / 标准 / 宽，仅桌面端）和字体（默认 / 衬线 / 等宽），保存在笔记 front matter 的 `lode` 键下，随文件同步。
- 桌面端正文右侧的目录条（可开关）：悬停展开目录，点击跳转，滚动时高亮当前标题。
- `[[双向链接]]`（重命名时自动更新引用）、反链面板、`#标签`、支持中文的全文搜索（SQLite FTS5 trigram）、快速切换器。
- 粘贴或拖入图片作为附件。

### 同步与 PWA

- WebSocket 实时推送变更；多设备同时编辑时自动三方合并，无法合并时生成冲突副本，不丢数据。
- 离线可读写，联网后自动同步；可安装为 PWA。

### 界面

- Apple 风格的桌面和移动端界面：深色模式、减弱动态效果、半透明材质；侧栏展开收起时编辑区和收起按钮跟随侧栏边缘平滑移动。
- 移动端手势：左缘返回、左右抽屉跟手拖拽（右缘左滑拉出右侧栏）、编辑工具栏。
- 多级设置页（分组列表 → 子页面，推入推出转场，每级有独立地址）；整体字号可调（按设备保存）。
- 退出登录前二次确认，有未同步的修改时会提示。

### MCP 与 API token

- 设置页创建只读或读写的 API token（只保存哈希）。
- `/mcp` 提供 Streamable HTTP 的 MCP 服务：搜索、阅读、列出、新建、修改、移动、删除笔记等工具。

### Agent 助手

- 接入 OpenAI 兼容、Anthropic、Gemini 三类供应商的多个模型；每个模型单独设置上下文窗口、最大输出、推理强度和输入模态（图片）。
- 笔记页里的助手以弹窗打开（桌面浮层、移动端可拖拽的底部面板），可以展开到助手页继续同一个会话，返回时回到原来的笔记和滚动位置。
- 输入框里输入 `@` 内联补全附上笔记；可从菜单切换模型和推理强度。
- 助手能调用笔记工具，修改笔记前需要确认；对话持久化，切换设备后可以继续，生成过程中断线重连不丢事件。
- 上下文超出窗口时，用模型对早期对话做摘要（带缓存，失败时退回启发式摘要）。
- 供应商 API key 加密保存，不出现在日志和接口响应里。主密钥默认自动生成在数据目录的 `secret.key`（备份会包含它），也可以用 `LODE_SECRET_KEY` 指定。
- 可选：用通行密钥（WebAuthn PRF）保护主密钥，开启后服务器上不保存可直接解开 API key 的材料，重启后用通行密钥登录即可解锁。

### 部署与运维

- 单个 Go 二进制（内嵌前端，无 CGO），Linux amd64 / arm64 / armv7、Windows amd64、macOS amd64 / arm64；`lode --version` 显示版本和 commit。
- 多架构 Docker 镜像（distroless、非 root、`HEALTHCHECK`、默认 `GOMEMLIMIT=100MiB`）；`docker-compose.yml`、Caddy 自动 HTTPS、systemd unit 示例。
- 运维子命令：`lode backup`（在线备份成一个 tar.gz）、`lode restore`（停服恢复，原数据保留）、`lode reset-password`、`lode healthcheck`。
- 启动时自动迁移数据库，迁移前自动备份；数据目录加文件锁，防止两个进程同时使用。
- 通行密钥（passkey）登录：可登记多个、查看和删除；仅在 HTTPS 或 localhost 下提供，密码登录始终保留；`lode reset-password --clear-passkeys` 可清除全部通行密钥。
- 安全响应头（CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`）；HTTPS 下会话 cookie 带 `Secure`；登录失败限速。
- 空闲内存约 22MB（Linux，1000 和 10000 篇笔记），见 `docs/benchmark.md`；性能基准工具 `server/cmd/bench`。

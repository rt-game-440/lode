# Lode 产品总规格

各阶段 issue 只写本阶段的增量，共同约定以本文件为准。需要修改本文件时，先在对应 issue 或 PR 里说明理由。

## 定位

自托管、单用户、跨平台的 Web Markdown 笔记应用，可安装为 PWA，多设备即时保存与同步，自带 Agent 助手并对外提供 MCP。目标是"自托管、同步更方便、自带 agent 的 Obsidian"。不做多人协作。

## 技术栈

- 后端：Go 单二进制，用 `embed` 内嵌前端产物；路由用标准库 net/http，依赖尽量少。SQLite 用 `modernc.org/sqlite`（纯 Go、免 CGO，便于交叉编译到 arm64 低配机）。
- 前端：React + TypeScript + Vite（pnpm）。编辑器用 CodeMirror 6 + `@codemirror/lang-markdown`，实时预览（光标不在的行隐藏 Markdown 标记）。状态管理用 zustand，动效用 motion，测试用 vitest + Playwright。
- 默认配置：`LODE_ADDR=127.0.0.1:8787`、`LODE_DATA_DIR=./data`、`LODE_SECRET_KEY`（阶段 5 用于加密 API key）。

## 数据

- 笔记 = `DATA_DIR/vault` 下的 `.md` 文件，目录就是文件夹，附件放 `vault/attachments/`。文件是唯一真相源，vault 能被 Obsidian 直接打开。
- SQLite `DATA_DIR/app.db`（WAL 模式）存：笔记索引（稳定 id、路径、rev、内容哈希、mtime）、全文索引、链接/反链/标签、历史版本（每次保存记一版）、全局变更序号 seq、会话、API token、AI 供应商与模型、对话记录、设置。
- 稳定 id 只存在数据库里，不写进文件。应用内重命名或移动时保留 id；外部改名时，启动对账或 fsnotify 发现"一个路径消失、一个新路径出现、内容哈希相同"，就视为改名并保留原 id。
- 全文搜索：FTS5 用 `trigram` 分词器以支持中文；少于 3 个字符的查询改用 LIKE 兜底。
- 外部直接修改文件：启动时全量对账，运行中用 fsnotify 监听并增量更新索引。写文件一律"临时文件 + rename"原子写。

## 笔记工具层

- `server/internal/notes` 是唯一的业务层，提供 list / read / create / update（整篇或 patch）/ move / delete（进回收站）/ restore / search / backlinks / tags。REST、MCP、Agent 都只做薄封装、调用它。
- 阶段 4 起，`server/internal/tools` 维护一份工具注册表（名称、给模型看的描述、JSON Schema、是否只读、处理函数），MCP 和 Agent 共用。

## 同步

- 写入携带 base_rev。与服务器 rev 不一致时，用历史版本做三方合并：改动不重叠就自动合并；重叠就保留服务器版本，把客户端版本另存为冲突副本 `名称.conflict-<设备>-<yyyyMMdd-HHmmss>.md` 并提示用户。
- 不用 CRDT：单用户场景冲突罕见，三方合并 + 冲突副本已够用，而且文件保持纯 Markdown。
- 服务器用 WebSocket 推送变更事件；客户端用 `since=seq` 增量拉取。
- 客户端用 IndexedDB 缓存，并维护离线写队列，联网后按顺序重放。

## 鉴权

- 单用户。首次启动时设置密码（argon2id），之后用 HttpOnly 会话 cookie 登录；登录失败限速。
- API token 在设置页创建/吊销，只存哈希，分只读和读写两种权限，供 MCP 和脚本使用。

## MCP

在 `/mcp` 提供 Streamable HTTP，用 Bearer API token 鉴权，tools 来自工具注册表。优先用官方 Go SDK `github.com/modelcontextprotocol/go-sdk`。

## Agent

- 供应商类型：OpenAI 兼容（覆盖 OpenAI / DeepSeek / OpenRouter / Ollama 等）、Anthropic、Google Gemini。每个供应商有：名称、类型、base URL、API key。API key 用 AES-GCM 加密存库，主密钥取自 `LODE_SECRET_KEY`（32 字节随机值的 base64，可用 `openssl rand -base64 32` 生成）。
- 每个供应商下可以有多个模型，每个模型单独设置：
  - 模型 ID、显示名；
  - 上下文窗口、最大输出；
  - 推理强度：off / low / medium / high，映射到各家的参数，不支持的模型隐藏这一项；
  - 输入模态：text / image / pdf / audio 多选；
  - 是否支持工具调用。
- 对话中可以切换模型；按当前模型的上下文窗口裁剪或压缩历史；SSE 流式输出，可中断。
- Agent 调用工具写笔记时，界面先显示 diff，默认需要用户确认。

## 界面

- 实现任何界面前，先加载 `apple-design` skill 并遵循。亮/暗色跟随系统；尊重 prefers-reduced-motion。
- 不打包 SF Pro 字体、不使用 SF Symbols 图标（许可证只允许在 Apple 平台上使用）：字体用系统字体栈（`-apple-system, BlinkMacSystemFont, "Segoe UI", ...`），图标用风格接近的开源图标库。
- 桌面三栏：文件树侧栏 / 编辑器 / 可收起的右栏（反链、大纲、Agent）；宽度 < 768px 时变为单栏导航栈。
- 功能最小集：
  - 文件夹树：新建、重命名、移动、删除；
  - GFM 编辑与实时预览、代码高亮、任务列表；
  - `[[wikilink]]` 补全与跳转，重命名时更新所有引用；
  - 反链、#标签；
  - 全文搜索、快速切换器（Ctrl/Cmd+K）；
  - 粘贴图片上传；
  - 回收站。

## 非功能

- 低内存：目标部署机只有 512MB 内存。1000 篇笔记时空闲 RSS ≤ 50MB；10000 篇时约 ≤ 120MB。
- 部署：
  - 单二进制：linux amd64/arm64/armv7、windows、darwin；
  - Dockerfile + compose 示例；
  - PWA 需要 HTTPS，文档给出 Caddy 反向代理示例。
- 安全：
  - 渲染 Markdown 时做 XSS 清洗；
  - 所有路径参数防目录穿越；
  - 除首启、登录和 `GET /api/health` 外，所有 API 都需鉴权。

## 阶段

| 阶段 | Issue | 内容 | 依赖 |
|---|---|---|---|
| 1 | #1 | 核心骨架与单机笔记 | 无 |
| 2 | #2 | 多端同步与 PWA | #1 |
| 3 | #3 | Apple 风格与移动端打磨 | #2 |
| 4 | #4 | API token 与 MCP 服务 | #1 |
| 5 | #5 | Agent 助手 | #3、#4 |
| 6 | #6 | 发布、部署与运维 | #5 |

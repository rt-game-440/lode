# 进度

## 阶段 1：核心笔记（issue #1）

**状态**：已完成，等待人工验收（`docs/checklist/stage-1.md`）。

已完成：

- 后端：Go 单二进制（嵌入前端），modernc sqlite（WAL、FTS5 trigram），文件为真相源，原子写入，启动对账 + fsnotify 监听，外部改名按 hash 保留 id；笔记、文件夹、回收站、附件、标签、反链、搜索、变更流接口（见 `docs/api.md`）；argon2id 单密码登录和 IP 限流。
- 前端：React 19 + Vite + CodeMirror 6 实时预览编辑器（标题、强调、代码块、任务列表、图片、`[[链接]]` 补全与跳转、`#标签`、frontmatter）；文件树（拖放、右键、键盘）、搜索、标签、回收站、反链/大纲/标签面板、快速切换、深色模式、手机单栏布局；500ms 自动保存和冲突提示条；每秒轮询 `/api/changes`。
- 测试：Go 单测；vitest（工具函数、语法扩展）；Playwright 冒烟（新建→保存→刷新→磁盘一致→搜索→删除→恢复；外部修改同步；重命名更新链接与反链）。
- 证据：`docs/evidence/stage-1/`（RSS、鉴权）、`docs/screenshots/stage-1/`。

遗留：

- 前端主包 720KB（gzip 243KB），阶段 3 考虑按需加载 CodeMirror 语言包。
- Windows 上 RSS（WorkingSet）18.6MB 达标；私有内存（已提交量）52.4MB。Linux 上的 RSS 待阶段 6 在 Docker 镜像里复测。
- 外部改名跨两个对账批次时 id 不保留（见 MEMORY.md 已知限制）。

下一步：阶段 2（多端即时同步，WebSocket 替换轮询）。

## 阶段 2：多端同步与 PWA（issue #2）

**状态**：已完成，等待人工验收（`docs/checklist/stage-2.md`）。

已完成：

- 后端：
  - diff3 行级三方合并（`internal/merge`）。不重叠的修改自动合并；重叠或 base 版本已被清理时，保留服务器版本，客户端版本另存为冲突副本，返回 409。
  - 历史版本保留 50 版或 30 天，后台定期清理；`changes_floor` 之前的 `since` 返回 410。
  - 写请求记录 `X-Device-Id` 和设备名。
  - `/api/ws` 推送变更并每 30s 发一次心跳，校验 Origin。
- 前端：
  - 同步引擎 `web/src/sync/`：IndexedDB 缓存笔记树和正文；写队列持久化；WS 实时推送；断线后先补齐、再重放。
  - 远端修改按 diff 映射套进编辑器，本地有修改时 rebase 并保存，输入法组字期间推迟。
  - 同步状态指示和冲突副本菜单；可以修改设备名；冲突 toast。
  - PWA：manifest、图标、SW 缓存应用壳、新版本提示、iOS meta。断网冷启动可用。
- 测试：
  - Go 单测：合并、冲突副本、base 缺失、changes 与 410、历史清理、WS。
  - 引擎单测 16 个。
  - Playwright `e2e/sync.spec.ts` 6 个：实时同步、离线两篇、冲突、自动合并、IME 推迟、PWA 离线冷启动。
- 文档：`docs/api.md`（409/410/WS 格式与客户端约定）、`docs/dev-https.md`（Caddy 本地证书）。
- 证据：`docs/evidence/stage-2/`（RSS：1000 篇、2 个 WS 连接时为 20.5MB）、`docs/screenshots/stage-2/`。

遗留：

- WS 连不上但 HTTP 正常时，状态仍显示“已同步”，只能在页面回到前台时补齐。可以考虑增加“实时连接中断”提示。
- 冲突副本没有可视化对比合并界面（范围外）。
- iOS 上的真实安装体验和真实输入法，待人工验收。

下一步：阶段 4（MCP）。

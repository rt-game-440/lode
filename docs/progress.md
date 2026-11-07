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

## 阶段 4：API token 与 MCP 服务（issue #4）

**状态**：已完成，等待人工验收（`docs/checklist/stage-4.md`）。

已完成：

- 后端：
  - API token：只存 SHA-256，分只读和读写两种权限，可吊销，记录最后使用时间（`internal/auth/tokens.go`）。
  - 工具注册表 `internal/tools`：10 个工具，描述写给大模型看，错误翻译成中文说明。阶段 5 的 Agent 复用这份注册表。
  - `/mcp`：官方 go-sdk v1.8.0，无状态 Streamable HTTP，Bearer 鉴权。只读 token 看不到写工具。
  - 审计日志 `internal/audit`：保留最近 1000 条。
  - MCP 写入走阶段 2 的合并和变更流，设备名为 token 名称。
  - REST：`/api/tokens`、`/api/audit`。
- 前端：设置页（侧栏底部齿轮，`/settings`）。可以创建 token（明文只显示一次，可复制，附 Claude Code 接入命令）、查看列表、吊销 token，查看调用记录；手机上表格改为卡片布局。
- 测试：
  - Go：`internal/mcpserver` 用 SDK 客户端覆盖全部工具和错误情况、401、只读权限、审计与变更事件；另有 `internal/tools`、`internal/audit`、`internal/auth` 的单测。
  - Playwright：`e2e/tokens.spec.ts` 3 个用例。
- 实测：Claude Code（haiku）经 MCP 完成搜索 → 读取 → 追加，浏览器未刷新就看到修改（`web/scripts/mcp-live-check.mjs`）；curl 示例见 `web/scripts/mcp-curl-check.sh`。
- 文档：`docs/mcp.md`（Claude Code 已实测，Codex、Cursor 未实测）、`docs/api.md`。
- 证据：`docs/evidence/stage-4/`、`docs/screenshots/stage-4/`。

遗留：

- Codex、Cursor 本机没有安装，接入写法未实测。
- REST API 不接受 Bearer token；以后如果需要脚本调用 REST，再考虑支持。
- MCP 的 OAuth、stdio 桥接、resources 和 prompts 不在本阶段范围内。

下一步：阶段 3。

## 阶段 3：Apple 风格与移动端打磨（issue #3）

**状态**：已完成，等待人工验收（`docs/checklist/stage-3.md`）。

已完成：

- 设计规范：`docs/design.md`。tokens（`web/src/styles/tokens/`）是颜色和动画时长的唯一来源，`src/styles/tokens.lint.test.ts` 扫描组件，发现字面量即失败。
- 材质：侧栏、顶栏、手机工具栏、菜单、快速切换器使用毛玻璃；不支持 `backdrop-filter`、减弱透明度、提高对比度时自动换成实色。
- 动效：统一弹簧（`motion.ts`），用于面板切换、侧栏展开收起（`panelMotion.ts`，只动 transform，可中途反向）、列表增删（`AnimatedList`）、快速切换器、对话框、菜单、toast、保存状态。减弱动态效果时用 `usePop` 和 `useReducedMotion` 改为淡入淡出。
- 手机：导航栈 `MobileStack`（左缘右滑返回，跟手、按速度投射落点）；右栏抽屉 `Drawer`（跟手拖拽、橡皮筋、快甩关闭）；编辑工具栏 `MobileToolbar`（标题、列表、任务、链接、`[[`、图片、收起键盘）；`visualViewport` 跟随软键盘；安全区；`pointer: coarse` 时行高 44px。
- 桌面与平板：侧栏拖拽调宽（200–420，记住宽度）、可收起；`?` 打开快捷键一览，设置页也有入口；文件树超过 2000 行时虚拟滚动。
- 无障碍：对话框、抽屉、快捷键一览有焦点陷阱；缺失链接和代码语言标签的对比度修正到 AA。
- 测试：
  - 单测：`format.test.ts`（Markdown 插入）、`gesture.test.ts`、`virtual.test.ts`、`tokens.lint.test.ts`。
  - Playwright：`e2e/visual.spec.ts`（axe 亮/暗 8 项、reduced motion 对照、375/768/1440 无横向滚动和重叠、手机可点区域 ≥ 44×44、2500 篇笔记虚拟滚动与键盘导航）；`e2e/touch.spec.ts`（CDP 触摸：左缘返回、弹回、抽屉跟手与焦点陷阱、手机工具栏）。
- 证据：`docs/evidence/stage-3/test.txt`、`docs/screenshots/stage-3/`（30 张截图、`video/` 下两段录屏，已用 frame-inspect 自查）。

遗留：

- 真机上的手势与系统手势（iOS Safari 边缘后退）的冲突、软键盘遮挡，待人工验收。
- 前端主包体积未处理（阶段 1 遗留）。
- axe 只断言 violations；毛玻璃背景上的对比度常被 axe 归为 incomplete（无法自动判定），这部分靠人工验收。
- `Drawer` 和 `MobileStack` 的拖拽逻辑结构相似，可以抽出共用的手势 hook（评审的判断性意见，未做）。
- e2e 里仍有按固定时间等待动画结束的写法。

下一步：阶段 5（Agent 助手）。

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

## 阶段 5：Agent 助手（issue #5）

**状态**：已完成，等待人工验收（`docs/checklist/stage-5.md`）。

已完成：

- 后端：
  - `internal/llm`：OpenAI 兼容（Chat Completions）、Anthropic Messages、Gemini 三个适配器，不用 SDK，直接 HTTP + SSE 解析。统一的流式事件（正文、思考、工具调用、用量）、错误分类（auth、rate_limit、context_length 等）和推理强度映射表；`ListModels` 用于测试连接。
  - `internal/secret`：`LODE_SECRET_KEY` 经 HKDF 派生 AES-256-GCM 密钥加密 API key，供应商 id 作关联数据。
  - `internal/agent`：供应商、模型、设置、对话、消息、待批准操作存 SQLite；上下文预算（窗口 − 最大输出 − 5%）按中英文分别估算 token，超出时先截断较早的长工具结果，再用当前模型把较早的轮次压缩成摘要（缓存、增量合并，失败时退回本地规则摘要），系统提示和最近一轮完整保留；所有客户端断开 30 秒后取消生成；Agent 循环复用阶段 4 的工具注册表，写工具先生成差异预览、停下等待批准；一次最多 20 次工具调用；助手写入的设备名为“助手”。
  - REST `/api/agent/*` 和 SSE 事件流；`GET /api/images` 列出笔记库里的图片。
- 前端：
  - 桌面在右栏新增“助手”标签页（右栏加宽到 380px），手机是 `/agent` 全屏页面；入口在侧栏底部和编辑器右上角。
  - 对话：流式 Markdown 渲染（复用编辑器的 Lezer 解析器，不用 innerHTML）、可展开的思考过程和工具卡片、写入审批卡片（逐行差异）、停止生成、上下文用量、会话列表。
  - 输入框：当前笔记默认附上，`@` 选择笔记，附件（从设备或笔记库选图片，按模型支持的模态限制），模型和推理强度选择。
  - 设置 → 助手：供应商增删改、测试连接、从模型列表导入、模型的全部参数、默认模型、自动批准开关；未设置 `LODE_SECRET_KEY` 时给出说明。
- 测试：
  - Go：三个适配器的流式文本、思考、工具调用、错误和取消；推理强度表驱动；Agent 循环（搜索 → 修改 → 待批准，批准改文件、拒绝不改）；中英文上下文裁剪；模型摘要与增量合并；客户端全部断开后取消、宽限内重连继续；API key 不出现在数据库明文、响应和日志里。
  - 前端单测：事件归并（`chatState.test.ts`）、Markdown 渲染与安全（`markdown.test.tsx`）。
  - Playwright：`e2e/talk-to-agent.spec.ts`，模拟 OpenAI 兼容服务跑完整流程，另有手机全屏页面用例。
- 证据：`docs/evidence/stage-5/`（全量测试输出、真实供应商冒烟输出），`docs/screenshots/stage-5/`（截图和录屏）。截图和录屏已推送到 Telegram（3 级验收）。

遗留：

- 本机没有设置 `LODE_TEST_*_KEY`，真实供应商冒烟全部跳过，留给人工验收第 1、3 项。
- 没有做对话内搜索、对话导出和按对话的系统提示自定义。

下一步：阶段 6。

## 阶段 6：发布、部署与运维（issue #6）

已完成：

- 运维子命令（`server/cmd/lode/ops.go`、`internal/ops`）：`backup`（`VACUUM INTO` 在线快照 + vault + trash 打包成 tar.gz，带清单）、`restore`（需停服，校验后替换，原数据移到 `pre-restore-<时间>/`）、`reset-password`、`healthcheck`；`serve` 和 `restore` 对数据目录加文件锁。
- 数据库：启动迁移前自动把旧库备份到 `backups/`（保留 5 份）。
- 安全头：新增 CSP；原有 `nosniff`、`Referrer-Policy`、`X-Frame-Options` 和 HTTPS 下的 `Secure` cookie 保持。
- 构建发布：`scripts/release.{sh,ps1}` 交叉编译 6 个平台并生成 `SHA256SUMS`；Dockerfile（node → go → distroless nonroot，`/data` 卷，`HEALTHCHECK`，`GOMEMLIMIT=100MiB`）；`docker-compose.yml`、`deploy/compose.caddy.yml` + `Caddyfile`、`deploy/lode.service`。
- CI（`.github/workflows/ci.yml`）：测试与构建（go vet / test、govulncheck、前端类型检查和单测、pnpm audit、Playwright 冒烟）、性能基准、容器冒烟（`scripts/docker-smoke.sh`：compose up + 冒烟、`--memory=256m` + 冒烟、发布二进制在容器里的健康检查）。Release（`release.yml`）：`v*` tag 触发，上传二进制和校验文件、推送多架构镜像到 ghcr.io。本阶段没有打 tag。
- 性能基准：`server/cmd/bench`，结果见 `docs/benchmark.md`。
- 文档：README 重写、`docs/deploy.md`、`CHANGELOG.md`（v0.1.0）、`docs/checklist/stage-6.md`。
- 证据：`docs/evidence/stage-6/`。

遗留：

- 本机没有 Docker，容器验收只在 CI 上跑；本机运行 govulncheck 被拒绝，同样由 CI 执行。
- `pnpm audit` 有 1 个 low、2 个 moderate，都在 vite-plugin-pwa → workbox-build 的构建期依赖里，不进入产物（`docs/evidence/stage-6/pnpm-audit.txt`）。

## 阶段 7：多工作空间（父 issue #54，分支 `stage-7-workspaces`）

设计见 `docs/workspaces.md`，任务说明见 `docs/stages/stage-7.md`。

已完成：

- #56 预重构：新增 `internal/workspace` Manager（目前只管默认工作空间，负责后台的监听、对账、历史清理）；按工作空间区分的接口改为从 request context 取工作空间，并额外挂到 `/api/w/{ws}/...`（只认 `default`，未知返回 `404 workspace_not_found`）。测试：`internal/workspace` 的启动顺序和关停测试，`internal/api/workspace_test.go` 的两种前缀结果对比（含 WebSocket）和未知工作空间 404。

- #57 新建内置工作空间：迁移 0006（`workspaces` 登记表，`api_tokens`/`audit_log` 加 `workspace_id`）；`GET/POST /api/workspaces`；新空间放在 `data/workspaces/<id>/{index.db,vault,trash}`，第一次访问时打开（先监听再对账），保持到退出，`Close` 停掉所有已打开空间的后台任务并关闭索引库；助手对话在非默认空间返回 `501 workspace_agent_unsupported`（#61 之前）。测试：`internal/workspace/registry_test.go`（升级后同构、按需打开与对账、关停不泄漏 goroutine）、`internal/api/workspaces_test.go`（隔离、WebSocket 隔离、列出新建、助手对话 501）。

- #58 前端切换工作空间：侧栏顶部换成工作空间名（`features/workspace/WorkspaceSwitcher`），点开是工作空间列表（当前项打勾、笔记数）和“新建工作空间…”；命令面板输入“切换工作空间”或工作空间名列出其他工作空间，也有“新建工作空间…”。默认工作空间地址不变，其他用 `/w/<id>/...`，API 加 `/api/w/<id>`（`lib/workspace.ts`）。同步引擎按工作空间实例化（IndexedDB `lode` / `lode:<id>`），切换时销毁旧引擎和 WebSocket，写队列留在各自的库里，切回来补发；最近打开、展开状态、当前助手对话按工作空间存（`lode.recent:<id>` 等），主题、布局、字号、编辑器偏好仍是全局的。非默认工作空间打开助手时显示“这个工作空间暂时不能用助手”和切回“笔记”的按钮。顺带修了快速切换器的过滤（标题匹配不上时加权后仍是非负，所有笔记都会列出来）和菜单高亮项提示文字的对比度。测试：`web/src/lib/workspace.test.ts`、`web/src/sync/workspace.test.ts`、`web/e2e/ui-workspaces.spec.ts`；截图在 `docs/screenshots/stage-7/`。

- #59 设置页管理工作空间、MCP token 绑定工作空间：`PATCH/DELETE /api/workspaces/{id}`（改名、排序；默认空间不能删，内置空间删除时停后台任务、关库，目录移到 `data/trash-workspaces/<id>-<时间>/`，登记和绑定的 token 一并移除）；`Manager.Rename/Reorder/Remove/SetBeforeRemove`；token 创建时可选 `workspace`（默认 `default`），`/mcp` 只访问 token 绑定空间的笔记，审计记录 `workspace`，`GET /api/audit?workspace=` 筛选。设置页新增“工作空间”分组（拖动或键盘排序、重命名、路径、删除确认），token 表单有工作空间下拉。测试：`internal/workspace/manage_test.go`、`internal/mcpserver/workspace_test.go`、`internal/api/workspaces_manage_test.go`、`internal/audit` 的 `TestListFiltersByWorkspace`、`web/e2e/ui-workspace-settings.spec.ts`。#61 合并后需在 `main.go` 注册 `workspaces.SetBeforeRemove(agentSvc.CloseWorkspace)`（已留 TODO）；#60 在 `disposeFiles` 里加外部目录分支。

- #60 外部目录工作空间与 `lode workspace`：`POST /api/workspaces` 接受 `vault_dir`（也接受 `vaultDir`），校验失败返回 `400 vault_dir_<原因>`（not_absolute / not_found / not_directory / unreadable / invalid / root / home / data_dir / inside_data_dir / contains_data_dir / same_vault / nested_vault），外部目录里不写任何东西（索引、回收站、锁都在 `data/workspaces/<id>/`）；外部目录不见了时访问返回 `503 workspace_vault_unavailable`，不重建目录；回收站跨磁盘时退回到复制 + 删除（文件和文件夹）；删除外部空间不动外部文件。`lode workspace list|add|rename|remove`（需停服，复用 `workspace.Manager`）。前端新建对话框加“使用已有文件夹”开关和绝对路径输入（错误显示在输入框下面），设置页外部空间的删除确认写明“不会删除你的笔记文件”。测试：`internal/workspace/external_test.go`（`TestCreateRejectsBadVaultDirs`、`TestExternalVaultReconcilesAndWatches`、`TestRemoveExternalWorkspaceKeepsEveryFile`、`TestExternalVaultMissingIsNotRecreated`）、`internal/api/workspaces_manage_test.go`（`TestExternalWorkspaceAPI`）、`cmd/lode/workspace_test.go`、`internal/vault` 的 `TestMoveFallsBackToCopyAcrossDevices`、`web/e2e/ui-workspace-external.spec.ts`、`web/src/features/workspace/names.test.ts`。人工验收：`docs/checklist/stage-7.md`（Obsidian 库交叉编辑）。

- #62 多工作空间备份恢复：`lode backup` 默认备份全部工作空间（格式 2：清单 `lode-backup.json` 列出每个空间，外部目录记原路径；`app.db` + `vault/` + `trash/` 仍是默认空间，其他空间放 `workspaces/<id>/{index.db,vault/,trash/}`，外部 vault 也打在 `workspaces/<id>/vault/` 下；每个 `index.db` 用 `VACUUM INTO` 在线快照；外部目录不可用时完整备份失败），`--workspace <id>` 只备份一个（不含 `secret.key` 和全局数据）。`lode restore` 恢复全部：外部 vault 回原路径，原路径非空返回 `ErrExternalNotEmpty` 并提示 `--external-to`，`--external-to <目录>` 把每个外部空间放到 `<目录>/<id>` 并更新登记路径；阶段 6 格式（format 1）按只有默认空间恢复；单空间备份只替换那一个空间（默认空间只替换 `app.db` 里属于它的表），其他空间和全局数据不动；恢复在 `txn`（`internal/ops/txn.go`）里做，失败回滚。tar 条目检查 `safeEntry` 覆盖 `workspaces/<id>/…`。测试：`internal/ops/workspaces_test.go`（`TestBackupRestoreAllWorkspaces`、`TestRestoreExternalNonEmptyAndExternalTo`、`TestRestoreStage6FormatBackup`、`TestSingleWorkspaceBackupAndRestore`、`TestSingleDefaultWorkspaceRestore`、`TestSafeEntryWorkspaces`、`TestRestoreRejectsEscapingWorkspaceEntries` 等）、`cmd/lode/ops_test.go`（`TestBackupRestoreCommandFlags`）；真实二进制往返冒烟输出在 `docs/evidence/stage-7/backup-restore.txt`。文档：`docs/deploy.md` 的“备份”“恢复多个工作空间”。

- #61 助手按工作空间隔离：`agent.Store` 拆出按空间的 `ChatStore`，对话、待审批操作、`@` 补全和工具调用只作用于当前工作空间；删除空间时先经 `SetBeforeRemove(agentSvc.CloseWorkspace)` 停掉它的助手任务。供应商、模型和设置仍是全局的。测试：`web/e2e/ui-workspace-agent.spec.ts`、`internal/agent` 的工作空间用例。

- #63 资源占用验收：`scripts/rss.sh` / `.ps1` 支持 `WORKSPACES=K`（`-Workspaces K`），外部大库耗尽监听句柄时记警告；结果见 `docs/evidence/stage-7/rss-summary.md`（默认空间相比阶段 6 的增量、3 个空间各 1000 篇且全部打开时的 RSS）。

- #64 文档与验收收尾：SPEC 新增“工作空间”一节和阶段表第 7 行，`AGENTS.md` 补阶段 7 = #54 的例外、新 e2e spec、`WORKSPACES=`、`backup-smoke`；`docs/workspaces.md` 改为已实现并更正字段名；CHANGELOG 新增 Unreleased（含全量 e2e 修复带出的产品修复：删除供应商/模型后清空默认模型、768 宽目录条不再遮挡标题、`@` 补全列表可聚焦、深色模式对比度、快速切换器筛选）；`scripts/backup-smoke.sh` / `.ps1` 取代临时脚本，证据 `docs/evidence/stage-7/backup-restore.txt`；3 级截图 `docs/screenshots/stage-7/ws-switcher-*.png`、`ws-settings-*.png`（手机 375 / 平板 768 / 桌面 1440，由 `screenshots.spec.ts` 的“截图 工作空间”用例生成，已推送 Telegram）；4 级清单 `docs/checklist/stage-7.md`（第 5–7 条为手机 PWA 切换、手机上管理并删除空间、绑定空间的 MCP token）；全量验证证据 `docs/evidence/stage-7/e2e-full.txt`、`tests.txt`。

状态：已完成。PR #65 已合并（2026-11-08）；人工验收 `docs/checklist/stage-7.md` 第 1–7 条全部通过（2026-11-11）。

遗留：

- 非默认工作空间的 `index.db` 与 `app.db` 同构，里面有几张永远为空的全局表（设计如此，见 `docs/workspaces.md` 第 3 节）。
- 同一个外部目录被两个 Lode 实例使用无法阻止，只在 `docs/deploy.md` 里写明。
- 助手真实供应商冒烟仍需自备 key（阶段 5 遗留，与本阶段无关）。

下一步：发布 v0.2.0（CHANGELOG 已定稿，合并后打 `v0.2.0` tag，需用户确认）。

## 发布前

- 修复：手机经局域网 HTTP 访问时一直显示“无法连接”（`crypto.randomUUID` 只在安全上下文可用，改用 `getRandomValues`，#14）。
- 人工验收：阶段 1 通过（2026-11-07）；阶段 2–6 通过（2026-11-08）。
- 验收反馈的 13 个问题（`docs/checklist/issues.md`，父 issue #16）拆成 ticket #17–#29，由子代理按指标选模型分三波修复，PR #30–#42 已合并（2026-11-08）。
- 第二轮验收反馈的 10 个问题（第 14–23 条，父 issue #43）拆成 ticket #44–#47，PR #48–#51 已合并，另有 PR #52 修复手机面板里 Esc 连带关闭（2026-11-08）。

已发布 v0.1.0（2026-11-08）。

## 导入本地文档（2026-11-11）

- 已完成：侧栏“导入笔记”按钮与文件树右键菜单，可选多个文件或整个文件夹（保留目录结构），重名自动改名；单测 `web/src/features/import/plan.test.ts`，e2e `web/e2e/ui-import.spec.ts`。
- 未做：zip 导入；笔记里引用的本地图片/附件不随导入处理（链接保持原样）；首页空状态没有加导入入口。
- 拖拽导入（2026-11-11）：把 `.md/.txt` 文件或文件夹从资源管理器拖进窗口即导入，落点决定目录，导入后自动打开第一篇；拖拽时显示全窗提示。单测 `dropped.test.ts`，e2e `ui-import-drop.spec.ts`。
- 表格渲染（2026-11-11）：编辑器里的 GFM 表格在光标不在表格内时渲染成真正的 `<table>`（对齐、加粗/代码/链接/wikilink/标签/图片），点击单元格或方向键进入时切回源码。单测 `tableModel.test.ts`，e2e `ui-editor-table.spec.ts`。顺手修了 `visual.spec` 的 2500 篇虚拟滚动用例（大量笔记目录改名排到最后，避免被后面新增的根目录笔记挤出可视区）。
- 仅浏览模式（2026-11-11）：笔记顶栏“仅浏览”按钮、Ctrl+Shift+E、设置里“打开笔记时默认仅浏览”（默认关）。浏览时正文和标题只读、不弹键盘、不显示格式工具栏和手机底部工具栏；表格保持渲染，链接直接打开，任务复选框仍可勾选。状态只在内存里，不写入笔记。e2e `ui-editor-browse.spec.ts`。手机真机上的滑动不弹键盘见 stage-7 清单 E。

## 第三轮需求（2026-11-14）

用户整理的 5 个需求发为 issue #71–#75（标签 `enhancement`、`ready-for-agent`，正文带指标）。#71、#73、#75 都改 `EditorPane.tsx`，所以先并行做 #72、#74、#75，#75 合并后再做 #71、#73。

- 已完成（三个代理在各自 worktree 并行开发，e2e 端口分别为 18871–18873）：
  - #75 标题移到顶栏（PR #76）：顶栏“路径 / 标题”，点击原地改名，去掉正文上方大标题。e2e `ui-title-topbar.spec.ts`，截图 `docs/screenshots/issue-75/`。
  - #74 设置浮窗（PR #77）：桌面居中模态浮窗，下面保留原页面（`stores/ui` 的 `underRoute`），手机不变。e2e `ui-settings-dialog.spec.ts`，截图 `docs/screenshots/issue-74/`。
  - #72 跨空间移动复制（PR #78）：`POST /api/w/{ws}/transfer`、文件树多选、目标选择对话框、拖到切换器。Go 测试 `internal/notes`、`internal/workspace`、`internal/api` 的 transfer 用例，e2e `ui-workspace-transfer.spec.ts`，截图 `docs/screenshots/issue-72/`。
  - 三个 PR 合并后的代码在本地预览版上人工验收通过（清单 `docs/checklist/stage-7.md` 第 F–P 条）；完整 e2e 在合并后代码上 205 通过，`split-view` 的动画速度用例偶发超阈值 0.6%，单独重跑通过。
- #71 记忆浏览位置（PR #79）：`lib/scrollMemory.ts` 改为按工作空间的本机记录（键 `lode.readpos[:<ws>]`，最近 200 篇），记“视口顶端行 + 行内偏移 + 光标”，`features/editor/useReadingPosition.ts` 负责记录和分几次校正恢复，用户一有操作就停止校正。e2e `ui-reading-position.spec.ts`。
- #73 选中文字悬浮框（PR #81）：`SelectionToolbar.tsx`、定位纯函数 `selectionLayout.ts`、`cm/selectionEvents.ts`；问助手经 `stores/agentDraft` 的 `quote` 带引用。e2e `ui-selection-toolbar.spec.ts`，截图 `docs/screenshots/issue-73/`（已推送 Telegram）。
- #79、#81 合并后的本地预览版人工验收通过（清单第 Q–Y 条）；合并后代码单测 204 个、相关 e2e 38 个通过。
- 遗留：`[[笔记#标题]]` 这类带目标位置的入口还没有，浏览位置“以目标为准”只能靠大纲 / 目录条验证；在已有 `**` 标记的行上拖选，实时预览显示标记导致文字右移，选区终点可能偏（编辑器原有行为）。
- 遗留：手机 375 宽下顶栏标题只剩约 6 个字宽（右侧 4 个按钮）；跨空间移动没有“撤销”，触屏上不能拖到切换器（用长按菜单）。

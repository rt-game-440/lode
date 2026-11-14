# MEMORY

跨任务复用的开发决策与经验，按时间降序。

## 2026-11-14 09:45 第三轮需求（#72、#74、#75）

- **跨空间传送用新 id**：移动、复制过去的笔记都是新 id、`rev` 从 1 开始，移动保留 `created_at`；目标不存在用单独的 `404 target_workspace_not_found`，不用 `workspace_not_found`（前端收到后者会以为当前空间没了并切回默认空间）。
- **传送先暂存再提交**：文件先写到目标里的隐藏临时目录（`.lode-transfer-*`），最后一起提交，失败全部撤回；本机有未同步修改时拒绝执行。
- **设置浮窗是模态的**：打开时 `.shell` 设 `inert`，`useFocusTrap` 跳过 inert 里的元素；e2e 里用 `getByRole('dialog')` 找其他对话框时要排除设置浮窗。768 宽按桌面处理（沿用 `max-width: 767px` 的手机断点）。
- **顶栏标题用界面字体**：不跟随笔记的 serif / mono 字体；浏览模式下标题按钮用 `aria-disabled` 而不是 `disabled`（保留键盘聚焦和读屏），e2e 点它要 `force: true`。
- **并行代理跑 e2e 要分端口**：`LODE_E2E_PORT` 区分（例如 18871–18873）；停掉代理时 `bin/lode.exe` 子进程可能残留占住端口和 `.e2e-data`，按端口查 PID 再杀。

## 2026-11-11 22:20 笔记页仅浏览模式

- **只读靠 Compartment 而不是临时改 dispatch**：`browseCompartment`（`editor/cm/setup.ts`）装 `EditorState.readOnly` + `EditorView.editable(false)`。`editorRef.extensions` 不含它，create / setState 时由 EditorPane 单独带上当前值，切换用 `reconfigure`，文档和光标都不动。
- **`readOnly` 只挡输入命令，挡不住代码直接 dispatch**：格式快捷键（`FORMAT_ACTIONS`）、图片粘贴拖入（`imagePaste`）、表格单元格点击和方向键进入表格、`revealLine` 的聚焦都要自己读 `state.readOnly` 判断。任务复选框（`toggleTask`）不拦，因为浏览时要能勾选。
- **浏览态存内存，不进 front matter**：`stores/browseMode.ts`；每次打开笔记按 `lode.editor.browseByDefault`（默认关）重置，不跨设备同步。
- **快捷键选 Ctrl+Shift+E**：Ctrl+E 已被行内代码占用（`formatActions.ts`），在 `AppShell.useShortcuts` 的 window 监听里处理，只在 `route.view === 'note'` 生效。
- **浏览时隐藏会改内容的入口**：“重命名”和“外观和布局”（会写 front matter 的 `lode` 键）从更多菜单移除；“移到回收站”保留。

- **块级装饰必须由 StateField 提供**（`editor/cm/tablePreview.ts`）：CodeMirror 不允许 ViewPlugin 给出 block 装饰，所以没有改 `livePreview.ts`（ViewPlugin），表格单独一个 field。只渲染顶层表格，引用 / 列表里的嵌套表格保持源码（避免吃掉 `>` 前缀）。
- **源码 / 渲染的切换看“用户是否操作过”**：笔记打开时光标默认在正文开头并自动聚焦，如果表格正好在开头会一直显示源码。所以 `interaction` field 记录 `focused` 与 `engaged`（出现过 select / input / delete / move / undo / redo 用户事件），两者都为真且选区与表格相交才切源码；整表被选中（Ctrl+A）仍保持渲染。
- **widget 的 `ignoreEvent()` 要返回 false**：返回 true 时 CodeMirror 的 `domEventHandlers`（包括 `linkClicks`）收不到 widget 内的事件。单元格位置存相对表格起点的偏移（`data-off`），点击时用 `view.posAtDOM(widget)` 换算，这样表格上方改动时 widget 不用重建。
- **方向键越过 widget**：垂直移动会直接跳过整块 widget，所以加了高优先级的 ArrowDown / ArrowUp，紧挨表格的那一行按键时把光标放进表格。
- **宽表格**：`.cm-content` 在 flex 的 `.cm-scroller` 里默认 `min-width:auto`，宽表格会撑出页面，要设 `min-width:0`，表格在 `.cm-table-scroll` 里横向滚动。
- **e2e 笔记名要排在“笔记 N”前面**：中文排序下 `tbl-*` 这类拉丁名排在“笔记”（pinyin bi）之后，会挤掉 visual.spec 滚到底的断言；本次 e2e 笔记用 `a-` 前缀。`split-view` 的逐帧采样用例在整套串行跑时偶发失败，单独重跑通过。

## 2026-11-11 20:55 拖拽文件到窗口导入并打开

- **监听在 window 捕获阶段**（`import/useDropImport.tsx`）：要早于 CodeMirror，否则编辑器会把拖入的文本文件内容直接插进正文。只含图片的拖拽不接管，仍由编辑器上传成附件；冒泡阶段另有兜底，把没人处理的文件拖放设为 `dropEffect=none`，避免浏览器直接打开文件、离开应用。
- **`webkitGetAsEntry` 必须在 drop 事件里同步取**，之后 `DataTransfer` 失效；取不到全部条目时整体退回 `dt.files`（脚本构造的 DataTransfer 就是这样）。遍历目录要循环 `readEntries` 直到空数组，并跳过 `.` 开头的目录。
- **落点**：文件夹行 → 该文件夹，笔记行 → 它所在文件夹，其他 → 根；导入后打开计划顺序里第一篇成功的笔记（`flow.tsx` 的 `open`），导入期间切走工作空间则不跳转。
- **e2e 无法真拖系统文件**：在页面里用 `DataTransfer` + `DragEvent` 派发；真实拖文件夹靠 `dropped.test.ts` 的假 `FileSystemEntry` 和人工清单。

## 2026-11-11 20:50 从本地文档导入笔记

- **纯前端导入**：浏览器读文件，逐篇（并发 3）调用现有 `POST /api/notes`（`auto_rename`），后端不改；新建本来就不进离线队列，离线导入直接报错。代码在 `web/src/features/import/`（`plan.ts` 纯函数可单测，`runImport.tsx` 执行，`pick.tsx` 选择与菜单入口）。
- **规则**：只收 `.md/.markdown/.txt`（统一存成 `.md`）；任一路径段以 `.` 开头（`.obsidian`、`.git`）整条跳过；非法字符换成 `-`；先严格 UTF-8、失败回退 GB18030，去 BOM、保留换行；单篇上限 32 MB。
- **入口**：侧栏头部“导入笔记”按钮（导入到根）、文件树空白处和文件夹右键菜单（导入到该处）。`webkitdirectory` 不支持时隐藏“导入文件夹”。
- **e2e 提示**：toast 最多叠 3 条且带“查看详情”的不自动消失，断言要用本用例独有的文本，或直接轮询磁盘文件。

## 2026-11-09 00:40 全量 e2e 既有失败修复

- **默认模型**：删除供应商或模型后，若 `settings.default_model` 指向的模型已不存在就清空（`agent/store.go` 的 `clearStaleDefault`），保证下一个新增模型自动成为默认。
- **目录条避让（#47）**：≥768px 时 `--note-width` 取 `min(页宽, 100% - 2*space-12)`，标题和正文两侧各让出 3rem，不隐藏目录条。
- **split-view 测量**：判断“跳变”要先按采样时间间隔把位移折算成速度再取变化，不要用按帧的位置二阶差分（rAF 抖动会被算成加速度）。
- **执行顺序**：`talk-to-agent.spec` 开头自己清空供应商；@ 补全列表 `ul.mention-list` 可滚动，必须 `tabIndex=0`（axe `scrollable-region-focusable`）。

## 2026-11-09 00:20 #62 多工作空间备份恢复

- **备份格式 2**：清单 `Manifest{Format:2, Scope: all|workspace, Workspaces[]{id,name,sort,created_at,external,vault_dir}}`，工作空间清单从 `app.db` 快照里读（和打包的库一致）。默认空间保持顶层 `app.db`/`vault/`/`trash/`（所以格式 1 备份无需转换，`Manifest.Entries()` 对没有 workspaces 的清单返回只有默认空间）；其他空间 `workspaces/<id>/{index.db,vault/,trash/}`，外部 vault 也放 `workspaces/<id>/vault/`（原路径只在清单里）。恢复接受 format 1 和 2。外部目录不存在时完整备份直接失败（不打出缺笔记的备份）；`trash-workspaces/`、`backups/`、`pre-restore-*` 不进备份，已写进 deploy.md。
- **`--external-to` 语义**：父目录，所有外部空间一起放到 `<目录>/<id>`（单空间备份同理），因为多个外部空间时一个目录无法表达。目标必须不存在或为空；校验在任何改动之前（数据目录重叠、与其他外部目录相同/嵌套、非绝对路径、根目录）。原路径非空返回 `ops.ErrExternalNotEmpty`（CLI 错误信息含 `--external-to` 提示）。`--external-to` 在没有外部空间的恢复里报错而不是静默忽略。
- **单空间备份语义**：非默认空间整体替换 `index.db`/`trash`/`vault`（已登记的沿用现在的登记：名称、排序、内置还是外部、外部路径；未登记的追加登记在最后，需要数据目录里已有 `app.db`）。默认空间的索引和全局数据同在 `app.db`：备份带 `app.db` 快照，恢复时在一个事务里用 `ATTACH` 只替换 `defaultIndexTables`（notes、notes_fts、links、tags、folders、versions、changes、trash、agent_chats/messages/pending）和 settings 的 `changes_floor`，并清掉 `sqlite_sequence` 里 changes/agent_messages 的计数使其跟随备份（与整库恢复一致）。现有整库先 `VACUUM INTO` 到 `pre-restore-*/app.db`。`TestDefaultIndexTablesCoverSchema` 逼着以后新增迁移加表时给表分类。单空间备份不含 `secret.key`。
- **恢复事务**：`internal/ops/txn.go` 的 `txn` 记录 `aside`（现有数据移到 `pre-restore-<时间>/`）、`place`（临时区放进来）、`placeExternal`（只放进空位；不存在先 rename，空目录或跨磁盘退回复制）并按相反顺序撤销；外部目录先放、数据目录后放。完整恢复会把现有 `workspaces/` 整体移走（即使是旧格式备份）；现有外部目录一律不动。`pre-restore-*` 名字同一秒重复时加 `-2` 序号（Windows 上重命名到已有目录会 Access denied，测试里连续恢复曾踩到）。
- **API**：`ops.Backup(ctx, d, dataDir, out, BackupOptions{ExcludeSecret, Workspace})`；`ops.Restore(...)` 保持 `(kept, err)`，新增 `ops.RestoreArchive(ctx, dataDir, archive, RestoreOptions{ExternalTo}) (Result{Kept,Scope,Workspaces}, error)`、`ops.ReadManifest(archive)`（CLI 在确认前列出备份内容）、`ops.ExternalTarget`。`workspace` 包新增导出的 `SamePath`/`Within`。
- **tar 安全**：`safeEntry` 允许 `app.db`、`secret.key`、`vault/…`、`trash/…`、`workspaces`、`workspaces/<id>`、`workspaces/<id>/index.db`、`workspaces/<id>/{vault,trash}/…`，`<id>` 必须是合法 id 且不是 default；其余一律拒绝。清单还会与解包出的 `app.db` 登记表交叉校验（id、是否外部、路径）。
- **冒烟**：`.claude/smoke-backup.sh <lode.exe>`（未提交）起真实服务、`workspace add`、服务运行中备份、清空、拒绝/恢复/`--external-to`/单空间/旧格式，输出存 `docs/evidence/stage-7/backup-restore.txt`。Windows 下 Bash heredoc 会吃反斜杠，含转义序列的 Go/脚本代码用 Write/Edit 写。
` 的 Go/脚本代码用 Write/Edit 写。

## 2026-11-08 23:55 #60 外部目录工作空间与 lode workspace

- **登记与路径（#62 备份恢复要用）**：登记表 `workspaces.vault_dir` 存**解析符号链接后的绝对路径**（空=内置）；`workspace.Info.External/VaultDir` 由它得出；`workspace.PathsFor(dataDir, id, vaultDir)` 给出 `Paths{Root,Index,Vault,Trash}`，外部目录只替换 Vault，Root（`data/workspaces/<id>`）、Index、Trash 仍在数据目录。`Manager.List/Info` 取登记信息；`Manager.Create(ctx, CreateOptions{Name, VaultDir})`；`Manager.CheckVaultDir(ctx, dir)` 单独校验（恢复到新位置时可复用，会拿 adminMu）；`Manager.DataDir()`。外部 vault 不在 `data/` 里，所以备份必须按登记表遍历 `vault_dir` 并在清单里记原路径。
- **校验（`internal/workspace/vaultdir.go`）**：`*VaultDirError{Reason, Msg}`，满足 `errors.Is(err, ErrInvalid)`；API 错误码 `vault_dir_<Reason>`，响应带 `reason`。顺序：非法字符 → 非绝对 → 不存在 → 非目录 → 读不了 → 根目录 → 主目录 → 数据目录相同/在里面/包含它 → 与已有外部目录相同/嵌套。比较前 `EvalSymlinks`，Windows/macOS 小写比较并用 `os.SameFile` 兜底。内置空间和默认 vault 都在数据目录里，由“数据目录”几条覆盖，不必逐个比。
- **外部目录消失不重建**：`openWorkspace` 对外部目录先 `checkVaultPresent`，不存在返回 `ErrVaultUnavailable`（API 503 `workspace_vault_unavailable`）。原因：`vault.New` 会 MkdirAll，卷没挂载时会得到空库，启动对账会把索引里的笔记全清掉。该空间仍可删除。
- **删除**：`disposeFiles` 没有为外部目录加分支：`PathsFor` 的 Root 永远不含外部 vault，所以和内置一样整体移到 `trash-workspaces/<id>-<时间>/`（保留 Lode 回收站里的笔记和对话，外部文件不动）。`TestRemoveLeavesExternalVaultAlone` + 新增哈希校验测试。
- **回收站跨磁盘**：`vault.moveFile` 本来就有复制+删除回退（现在复制失败/删原文件失败会清理目标，避免留下两份）；文件夹删除原来直接 `os.Rename`，改为 `vault.MoveDirOut`（重命名失败则复制树再删）。`vault.rename` 是可替换的变量，测试用它模拟跨设备。
- **CLI**：`cmd/lode/workspace.go` 的 `runWorkspace(cfg, args, out)`：先校验参数再 `ops.Lock`（运行中报“lode 服务正在运行”），建临时 `workspace.Manager`（默认空间用 `notes.New` 但不 Start，日志丢弃）直接调 Create/Rename/Remove/List，所以语义与接口一致；`list --json` 输出与 `GET /api/workspaces` 相同结构。remove 不加确认（内置空间只是移到 trash-workspaces，外部空间不动文件）。
- **API 字段名**：沿用 snake_case `vault_dir`，同时兼容 `vaultDir`（两个都给且不同 → 400）。
- **前端**：`components/overlays` 新增 `customDialog<T>(render)`（kind 'custom'，Esc/点遮罩返回 null）；`features/workspace/CreateWorkspaceDialog.tsx` 用它做新建对话框，创建请求在对话框内发出，服务器的 `vault_dir_*` 错误显示在路径输入框下面；纯函数 `names.ts`（`invalidWorkspaceName`、`looksAbsolute`）单独成文件，便于单测（导入 stores 的模块在 vitest 里没有 location）。
- **工具坑**：Bash 工具里的 heredoc 会吃掉反斜杠（Windows 路径、正则），含反斜杠的文件用 Write/Edit 工具写。

## 2026-11-08 23:25 #61 助手按工作空间隔离

- **库划分**：`agent.Store` 只管全局数据（供应商、模型、设置、API key，app.db）；`agent.ChatStore` 管对话三张表。默认空间用 `Store.DefaultChats()`（app.db，所以升级前的对话自然属于默认空间），其他空间用 `Workspace.Chats`（各自 index.db，Manager 打开时创建，默认空间为 nil）。统一用 `Workspace.AgentSpace(defaultChats)` 取 `agent.Space{ID, Chats, Tools, Notes}`。默认空间不用 Manager 的 Chats，是因为 api 测试里 agent 的库和默认空间的 app.db 不是同一个；生产中是同一个库。
- **Service**：全局一个，`Space` 由调用方每次传入；运行记录、订阅、空闲计时按“空间 id/对话 id”区分，一次生成固定用同一个 Space，切换空间不影响它。“模型存在”检查在 `Service.UpdateChat`（模型是全局的），`ChatStore.UpdateChat` 不查。
- **删除空间**：`main.go` 注册 `workspaces.SetBeforeRemove(agentSvc.CloseWorkspace)`，在空间不可访问之后、关 index.db 之前取消并等待它的生成任务；之后该 id 永不再接受生成（id 不复用）。对话随目录一起移走。退出顺序：先 `agentSvc.Close()` 再 `workspaces.Close()`。
- **e2e**：`ui-workspace-agent.spec.ts` 自己起 lode（临时目录、随机端口、`LODE_SECRET_KEY`、不带 key 的模拟供应商），不受 spec 执行顺序影响。Windows 本机的 `python3` 是 Windows Store 空壳，要用 `python`。

## 2026-11-08 23:10 #59 设置页管理工作空间，MCP token 绑定工作空间

- **Manager 管理方法**：`Info(ctx,id)`、`Exists(ctx,id)`、`Rename(ctx,id,name)`、`Reorder(ctx,id,pos)`、`Remove(ctx,id) (RemoveResult{Trash,RevokedTokens}, error)`、`SetBeforeRemove(fn func(id string))`。锁 `createMu` 改名 `adminMu`（新建、改名、排序、删除互斥）。默认工作空间删除返回 `ErrProtected`（API 403 `forbidden`）；管理对象不存在返回 `404 not_found`，不用 `workspace_not_found`（前端收到后者会切回默认空间）。
- **删除顺序**：标记 `removing`（`Get` 返回 `ErrNotFound`）→ 等进行中的打开 → 从 `open`/`order` 摘掉 → `beforeRemove` 回调 → 取消后台任务并等待、关库、关 `Gone()` 通道（WebSocket 据此退出）→ 一个事务里删 token 和登记行 → 移目录 → 提交（失败则 `undo` 把目录移回）。**#60 扩展点**：`disposeFiles(id, vaultDir)`，外部目录在这里加分支，只清 `data/workspaces/<id>/`，外部笔记文件不动。**#61 扩展点**：`SetBeforeRemove`，main.go 里有 TODO，合并后注册 `agentSvc.CloseWorkspace`；回调在锁外、库关闭前执行。
- **回收目录**：`data/trash-workspaces/<id>-yyyyMMdd-HHmmss/`，重名加 `-2`；源目录不存在时建空占位。Windows 上刚关的监听和 SQLite 句柄会让 rename 短暂 Access is denied，`renameWithRetry` 最多重试约 3 秒（其他系统不重试）。
- **sort 语义**：PATCH 的 `sort` 是目标位置（0 起），整表重新编号 0..n-1；默认工作空间也能排序和改名，列表不再强制默认在最前。
- **token 绑定**：`api_tokens.workspace_id`（0006 已有）；`CreateToken(ctx,name,scope,workspace)` 空串等于 default；创建时校验空间存在（400）。`mcpserver.Options.Workspaces` 取代单一 `Tools`：验证 token 时解析所属空间的 `tools.Registry`，空间已不存在返回 `ErrInvalidToken`（401）。审计记录 `workspace`，`GET /api/audit?workspace=` 筛选。
- **前端**：设置新增“工作空间”分组（列表页拖动或键盘排序，`Reorder.Group` + 仅把手可拖；详情页重命名、路径、切换、删除）。`stores/workspace` 加 `rename/reorder/remove/setList`，`listSeq` 防止过期的列表请求把已删除的空间加回来；删除当前空间先 `switchTo(default)` 再请求删除。token 创建表单有工作空间下拉（默认当前空间），列表和详情显示所属空间。
- **深色危险按钮**：深色模式 `--color-on-danger` 改为 `#1c1c1e`，否则 `.btn-danger` 的对比度不过 axe。

## 2026-11-08 21:35 #58 前端切换工作空间

- **当前工作空间**：`lib/workspace.ts` 是唯一来源。`currentWorkspace()` / `setCurrentWorkspace(ws)`（模块加载时从 `location.pathname` 解析），纯函数 `apiPrefix(ws)`（`/api` 或 `/api/w/<id>`）、`routePrefix` / `workspacePath(ws, path)` / `splitWorkspacePath(pathname)`（默认空间不加前缀，其他是 `/w/<id>`，首页是 `/w/<id>`）、`storageKey(base, ws)`（默认原键名，其他加 `:<id>`）、`WORKSPACE_STORAGE`（recent、expanded、agentChat）、`localDbName(ws)`。`stores/ui` 的 `parseRoute` / `routePath` 仍是不带前缀的路径，`navigate` 和 `syncFromLocation` 负责加减前缀；设置页的 `lodeFrom` 存不带前缀的路径。
- **API 客户端**：`api` 是全局接口加 `notesApi(() => apiPrefix(currentWorkspace()))`，笔记相关接口每次调用时读当前工作空间；`workspaceApi(ws)` 固定前缀，给同步引擎用（旧引擎在切换后收尾的请求不会打到新空间）。助手的对话接口按工作空间，供应商、模型、设置是全局的。`setWorkspaceMissingHandler`：任何请求收到 `404 workspace_not_found` 时提示并切回默认空间（地址写错、空间被删）。
- **同步引擎换实例**：`sync/engine` 的 `export let sync` 是活绑定，`switchSyncEngine(ws)` 新建引擎、`adopt` 旧引擎的订阅（listeners 对象和 `isKnown`）、`dispose` 旧的（停止 WebSocket，不再发事件、不再改 `useSync`，进行中的补发和追赶结束后关闭 IndexedDB），已启动时立即启动新的。所有代码都通过 `sync.xxx` 访问，不要把 `sync` 存到局部变量里跨 await 使用（`vault.load` 用 `engine !== sync` 丢弃过期结果）。
- **切换流程**（`stores/workspace` 的 `switchTo`，串行执行）：编辑器 `flush` 把没交给同步引擎的修改交给旧引擎（离线时进入旧空间的写队列）→ 写笔记树缓存 → `setCurrentWorkspace` → 关编辑器、`resetVault`、`useAgent.switchWorkspace()`、关助手弹窗和快速切换器 → `switchSyncEngine` → 导航（默认 push，后退能回到原空间；浏览器前进后退用 `history: 'none'`）→ 载入笔记树、刷新列表。`MainView` 没有按工作空间加 key（手机上会把旧笔记滑出到新空间），各组件自己订阅 `useWorkspace(s => s.current)`。`FileTree` 按工作空间加 key，展开状态各存各的。
- **列表缓存**：`lode.workspaces`（全局键）缓存工作空间列表，离线冷启动也能显示名称。退出登录用 `clearAllLocalCaches()` 清掉所有已知工作空间的离线缓存（写队列保留）。
- **助手**：非默认空间的对话接口返回 501，`useAgent` 设 `unsupported: true`，面板显示 `agent-unsupported` 提示和切回“笔记”的按钮，不弹错误提示。#61 实现后去掉。
- **命令面板**：至少两个字才列命令（避免一个字模糊匹配到“切换工作空间”），命令排在笔记结果之后、“新建笔记”之前。顺带修了已有的过滤问题：标题分数 -1 加 50 后变成 49，所有笔记都会出现在任何查询里。
- **菜单提示文字**：高亮项（强调色背景）上的 `.menu-hint` 去掉了 0.8 透明度，axe 测到对比度不足。
- **e2e**：`ui-workspaces.spec` 在公共实例里建了一个名为“工作”的空间；后面只有 visual.spec，不受影响。重新打开快速切换器前要等它关闭动画结束，否则 AnimatePresence 复用正在退出的组件，输入框里还有上次的文字。

## 2026-11-08 21:03 #57 新建内置工作空间、按需打开

- **迁移 0006**：`workspaces(id, name, vault_dir, sort, created_at)` 登记表并插入 `('default','笔记','',0,now)`；同时加 `api_tokens.workspace_id`、`audit_log.workspace_id`（默认 `'default'`），#59 不用再迁移。`index.db` 和 `app.db` 跑同一套迁移，所以 `index.db` 里也有一行 default 登记（没人读）。约定写在 `db` 包注释：迁移只能写结构变更和常量，不能读全局表的数据回填。新增 `db.MigrateTo(ctx, db, version)` 用来在测试里构造旧版本库；迁移前备份按库文件名命名（`app-v*.db` / `index-v*.db`）。
- **Manager**：`workspace.Options` 加 `DB`（app.db，登记表）、`DataDir`、`Now`；`DB` 为 nil 时只有默认工作空间（`api.Server` 只传 `Notes` 的旧写法）。`Create(ctx, CreateOptions{Name}) (Info, error)`：id 为 6 位 `[a-z0-9]`（crypto/rand，跳过已登记和目录已存在的），先建 `vault/`、`trash/` 和迁移好的 `index.db` 再写登记表（`sort = max+1`），失败时删掉目录；不打开。`List(ctx) ([]Info, error)` 不打开工作空间，`note_count` 对没打开的临时 `db.Connect` 它的 index.db 数一次。`Get` 对未打开的：校验 id 格式 → 查登记表 → 打开 index.db（`db.Open` 迁移）→ `notes.New`；并发 Get 用 `opening` 通道只打开一次，打开过程用 `context.WithoutCancel`；Start 之后打开的立即 `startLocked`（先监听再对账，历史清理各跑一份）。`Close` 后 `Get` 未打开的返回 `ErrClosed`；Close 等后台任务结束后关闭 Manager 打开的 index.db（app.db 仍由 main 关）。`PathsFor(dataDir, id, vaultDir) Paths{Root, Index, Vault, Trash}` 统一路径（default 是 `data/{app.db,vault,trash}`）。`IsOpen(id)` 供测试。新增 `notes.Service.NoteCount`。
- **API**：`GET /api/workspaces` → `{"workspaces":[Info]}`，`POST /api/workspaces {name}` → 201 Info。JSON 字段沿用现有接口的 snake_case（`vault_dir`、`note_count`、`created_at`），没有用设计文档里的 camelCase。传 `vault_dir` 时 400（外部目录留给后续票），名称为空、超过 64 字符、含控制字符时 400。重名允许。
- **助手对话在非默认工作空间**：选了“返回明确错误”——`agentChatRoutes()` 的每个处理函数包一层 `defaultWorkspaceOnly`，非 default 返回 `501 workspace_agent_unsupported`。不走全局对话，因为全局对话的工具绑定的是默认工作空间的笔记，会串数据。#61 拆出 ChatStore 后删掉这层。
- **测试**：`api` 包的 `newServer` 现在总是带登记表的 Manager（数据目录就是测试临时目录，不启动后台任务；需要的测试在选项里调用 `s.Workspaces.Start(t.Context())`）。`workspace` 包的 goroutine 泄漏测试比较 `runtime.NumGoroutine()`，基线在打开 app.db 之后取。本机没有 gcc，`-race` 跑不了。
- **没做**：~~`lode backup/restore` 还不包含 `data/workspaces/`~~（#62 已做），MCP 仍只服务默认工作空间（#59）。

## 2026-11-08 20:30 #56 工作空间接入点（预重构）

- **Manager**：`internal/workspace`。`workspace.New(Options{Default: *notes.Service, Logger, Debounce, PruneInterval})` 立即可用；`Start(ctx)` 启动每个已打开工作空间的后台任务（先 `Watch` 建好监听再 `Reconcile`，另一个任务定期 `PruneHistory`），`Close()` 取消并等它们结束，可重复调用。`Get(ctx, id)` 现在只认 `default`，其他返回 `workspace.ErrNotFound`；#57 在 `Get` 里按需打开（打开后用 `Start` 时保存的 ctx 启动后台任务）。`Workspace{ID, Notes, Tools}`，`Tools` 由 `tools.New(Notes)` 构造，MCP 和助手都从默认工作空间取。会话清理仍在 `main.go`，是全局的。`main.go` 退出顺序：取消会话清理 → `workspaces.Close()` → `agentSvc.Close()` → 关库。
- **context**：`workspace.WithContext` / `workspace.FromContext`；api 里用 `currentWorkspace(r)`、`wsNotes(r)`（没有工作空间时 panic，说明路由没挂对）。
- **路由**：按工作空间区分的路由集中在 `api/workspace.go` 的 `workspaceRoutes()`（模式写原路径 `/api/...`，助手对话路由在 `agentChatRoutes()`），每条在会话 mux 上挂原路径（`inWorkspace("default")` 包一层），再挂到一个单独的 mux；`/api/w/` 前缀处理函数解析 `{ws}`、放进 context、去掉 `/w/{ws}` 后交给那个 mux。这样两种前缀的匹配、405、404 完全一致，全局接口不会出现在前缀下。新增按工作空间的接口只要加进 `workspaceRoutes()`，测试会遍历它检查未知工作空间的 404。
- **404 格式**：`{"code":"workspace_not_found","message":"工作空间不存在","error":"workspace_not_found"}`——issue 要求 `error` 字段，同时保留统一错误格式的 `code`/`message`。未登录先 401。
- **兼容**：`api.Server.Notes` 保留，`Workspaces` 为 nil 时 `Handler()` 用它构造只有默认工作空间的 Manager（不启动后台任务），现有测试不用改。`agent.Service` 的 `Notes`/`Tools` 字段不动，对话处理函数经 `s.chatAgent(r)` 取助手服务，#61 在那里改成按工作空间取 `ChatStore`。附件上传返回的 `url` 由 `apiPrefix(ws)` 拼，默认工作空间仍是 `/api/files/...`。

## 2026-11-08 18:20 #47 整体字号

- **实现**：`stores/displayPrefs.ts`（localStorage `lode.display.fontSize`，标准档不存），`applyFontSize` 在 `main.tsx` 渲染前执行，给 `<html>` 加 `data-font-size`；`global.css` 按它把根字号设为 `--root-size-small/large/xlarge`（87.5% / 112.5% / 125%）。百分比相对浏览器默认字号，所以尊重用户的浏览器设置；界面和正文都用 rem，一起缩放。
- **界面**：“设置 → 外观 → 字号”，分段控件两端是小 A、大 A，下方是正文预览；分段单选组件抽到 `components/RadioGroup.tsx`，外观面板和设置共用。
- **测试**：截断检查比较文字的 Range 范围和元素盒子，不用 `scrollWidth`（分段控件、`hit-expand` 的伪元素会扩大点按区域，被算成溢出）。模拟浏览器默认字号用 CDP `Page.setFontSizes`。

## 2026-11-08 17:55 #47 目录条

- **开关**：全局、按设备，`stores/editorPrefs.ts` 的 `tocRail`（localStorage `lode.editor.tocRail`，默认开）。入口在“设置 → 通用 → 编辑器”和笔记“外观和布局”面板，两处同一个状态。手机不显示，没有标题时不显示。
- **位置**：`TocRail.tsx` 放在 `.editor-scroll` 开头一个高度为 0 的 sticky 元素里，目录条和卡片绝对定位在右上角，不占布局。标题坐标用 `view.lineBlockAt(line.from).top + view.documentTop`（视口外的行是估算值）。
- **当前项**：滚动区顶部往下 30% 的线以上最后一个标题；滚到底时取最后一个。跳转动画期间高亮固定在目标上。
- **跳转**：不能用原生 `scrollTo({behavior:'smooth'})`——CodeMirror 测量行高时会改滚动位置，原生平滑滚动在第一帧就被打断。用 motion 的 `animate` 推进比例、每帧重算终点，最后 `EditorView.scrollIntoView(pos, {y:'start'})` 对齐。

## 2026-11-08 17:36 #47 按笔记的外观写进 front matter

- **键名**：front matter 顶层的 `lode` 映射，子键 `width`（`narrow` / `standard` / `wide`）和 `font`（`sans` / `serif` / `mono`）。默认值（`standard`、`sans`）不写；`lode` 下没有键时删掉 `lode` 行，front matter 因此变空时整块删除。读写都在 `web/src/lib/noteAppearance.ts`（纯函数）：新建时写块状 YAML（两格缩进），已有行内写法 `lode: {width: wide}` 时沿用；`lode` 下认不出的子键原样保留；保留 CRLF。front matter 的识别与编辑器的 Lezer 扩展一致（第 1 行 `---`，下一行像 YAML 键），服务端 `mdparse` 只读 `tags`，`lode` 不影响标签和链接（`TestFrontmatterAppearanceKeyIgnored`）。
- **写入路径**：“外观和布局”面板调用 `applyNoteAppearance(view, patch)`，把新旧全文的 diff 作为一次普通编辑派发给 CodeMirror（带 `appearanceWrite` 标记、可撤销），之后由 Autosaver → `sync.save` 走正常的版本号、三方合并和冲突处理。外观状态从文档派生（`cm/appearance.ts` 的 StateField），载入、远端合并、撤销都会自动更新，界面读 `stores/noteAppearance`。
- **编辑器里藏起 `lode`**：front matter 只有 `lode` 时整块藏起（block replace 装饰），有别的键时只藏 `lode` 几行。光标进不去（transactionFilter 把选区挪到正文开头或相邻行），普通编辑改不到（changeFilter 连同两端的换行一起保护，两端插入不受影响）；`appearanceWrite`、撤销重做、`remoteSync` 事务不受限制。载入笔记时光标放在 `bodyStart()`。

## 2026-11-08 14:22 #29 用通行密钥（PRF）保护 API key

- **结构**：`secret.Keeper` 统一管理主密钥（`env` / `file` / `passkey` 三种模式，`passkey` 模式锁定时加解密返回 `secret.ErrLocked`），`agent.Store` 只依赖 `secret.Cipher` 接口；`internal/keyprotect` 管开关（`settings.key_protection='passkey'`）和开启、解锁、加入、锁定、关闭；HTTP 在 `api/keyprotect.go`。启动顺序：`keyprotect.Enabled` → `secret.OpenKeeper` → `agent.NewStore` → `passkey.New` → `keyprotect.New`，再把 `passkey.Service.PRFSalt` 设为 `keyProtect.LoginSalt`（只在开启时给登录/登记加 PRF 盐）。
- **密码学**：每个实例一个 32 字节 PRF 盐（`settings.key_protection_salt`，不保密、不轮换）。包裹密钥 = HKDF-SHA256(PRF 输出, info `"lode master key wrap v1|"+凭据 ID`)，AES-256-GCM，AAD `w1:`+凭据 ID，存在 `passkeys.extra.key_wrap`。开启时换新主密钥并重新加密已存的 key（旧 secret.key 和旧备份解不开新数据）。PRF 输出只在请求处理期间存在，用完 `clear()`，不写日志。
- **崩溃安全**：开启先提交数据库再删 secret.key；关闭先原子写 secret.key 再提交；启动时数据库是“已保护”就删除残留的 secret.key。
- **PRF 时机**：登记总是请求 `prf: {}`（只探测），开启后登记带盐；多数平台登记时只返回 `enabled`，要再做一次验证（`action: enroll`）才拿到输出。Safari 要求每次 WebAuthn 调用都有用户手势，所以登记后不自动连着弹第二次，改为提示里的“加入保护”按钮。
- **测试**：`passkeytest` 软件认证器实现了 PRF（HMAC-SHA256(PRFKey, SHA-256("WebAuthn PRF"‖0‖salt))），`NoPRF`、`PRFAtCreate` 模拟不同平台。e2e `ui-passkey-protect.spec.ts` 自己起一个不带 `LODE_SECRET_KEY` 的 lode（临时目录、随机端口），用 CDP 虚拟认证器 `hasPrf: true`，能真正重启验证锁定。Windows 上数据目录的 `.lock` 被 LockFileEx 锁住，扫描文件内容时要跳过。

## 2026-11-08 13:20 #28 通行密钥（WebAuthn）

- **库**：`github.com/go-webauthn/webauthn`（纯 Go，`CGO_ENABLED=0` 可编译，依赖 fxamacker/cbor、golang-jwt、go-tpm 等均无 CGO）。已经内置 PRF 扩展选项（`WithExtensionPRFSupport`、`WithExtensionPRF` 等），#29 直接用。
- **RP ID / origin**：每次仪式按请求推导（`passkey.RPFromHost`）：Host（直连方是可信代理时优先 `X-Forwarded-Host`）去掉端口作 RP ID，`isHTTPS` 决定协议；IP 地址（含 127.0.0.1、::1）不是合法 RP ID，返回 `passkey_unsupported`。每次仪式单独 `webauthn.New`，仪式记录里存 RP/origin，完成时沿用（等于把仪式绑在开始时的 origin 上）。仪式记录存内存，5 分钟过期、只能完成一次、最多 64 个。
- **数据模型**：迁移 `0005_passkeys.sql`，表 `passkeys(id, name, rp_id, credential, extra, created_at, last_used_at)`。`credential` 是 `webauthn.Credential` 的 JSON（含签名计数），`extra` 是预留的 JSON（恒为 `{}`），#29 把每个通行密钥各自包裹的主密钥放进 `extra`（或另建关联表）。选项构造的扩展点是 `passkey.Service.RegistrationOptions` / `LoginOptions`，#29 在那里追加 PRF 选项，PRF 结果通过浏览器 `getClientExtensionResults()` 取得（前端 `lib/webauthn.ts` 已把 `clientExtensionResults` 带给服务端）。
- **登录**：可发现凭据（`residentKey: required`、`userVerification: required`），不限定 `allowCredentials`；用户句柄是存在 `settings.passkey_user_handle` 里的 32 字节随机数。登录接口沿用密码登录的 `Limiter`（同一个计数），begin 只检查是否被锁定，finish 失败才计一次。签名计数异常（`CloneWarning`）只记日志不拒绝，因为有密码兜底。
- **reset-password**：默认保留通行密钥，`--clear-passkeys` 才删除。理由写在 docs/deploy.md。
- **前端可用性**：`passkeyAvailable()` = `isSecureContext` + 支持 WebAuthn + 主机名不是 IP。登录页按钮还要求服务端 `auth/status.passkey` 为真（该域名下登记过）。
- **测试**：Go 用 `internal/passkey/passkeytest` 的软件认证器（ES256、无证明）驱动完整仪式；e2e 用 CDP `WebAuthn.addVirtualAuthenticator`，必须经 `http://localhost:<端口>`（`127.0.0.1` 不能当 RP ID），spec 为 `ui-passkey.spec.ts`（排在 smoke 之后）。Go 测试里要在同一连接上模拟不同 Host，标准库 cookie 罐会按 Host 头区分站点，测试自己管 cookie。

## 2026-11-08 12:49 #23 设置多级页面

- **路由**：`Route` 的 settings 带 `sub?: string[]`，地址是 `/settings/<段>/...`；页面表和标题在 `web/src/features/settings/stack.ts`。新增设置页时在那里加路径和标题，再在 `SettingsView` 的 `Page` 里加一个分支，并在首页加一行。#26 的“显示格式工具栏”开关在 `/settings/editor`（`GeneralSettings.tsx` 的 `EditorPage`）。
- **e2e 里的假 key**：GitGuardian 会把 `api_key: 'sk-mock-e2e-1234'` 这种写在对象字面量里的值报成 Generic High Entropy Secret。截图之类不需要 key 的种子数据就不要带 key。
- **历史**：设置内的链接用 `openSettings()`：pushState 后在这条历史记录的 state 里写 `lodeFrom`（来源路径）。返回按钮只在 `lodeFrom` 正好是上一级时用 `history.back()`，否则 `navigate(上一级, replace)`，所以直接打开深层地址再点返回不会跳出应用，正常进入再返回也不会在历史里多出记录。
- **导航栈**（`NavStack.tsx`）：从首页到当前页的每一层都保持挂载（返回时保留滚动位置），只有最上层的 x 是 motion value，下层的视差和遮暗由它推导；动画结束时最上层的 transform 是 none，层内的 `position: fixed` 弹窗不受影响。
- **两个返回手势不冲突**：手机上设置的子页面有自己的左缘手势区（`settings-edge-swipe`），外层 MobileStack 的手势区在设置深度大于 0 时用 CSS `:has()` 隐藏（`settings.css`），没有改 MobileStack。
- **样式顺序**：`settings.css` 里和 `.view`、`.view-bar`、`.view-title`、`.view-body` 同元素的规则要写成双类选择器（如 `.view-bar.settings-bar`），否则 views.css 后加载会覆盖。
- **Chrome 模拟触摸**：CDP 派发的快速甩动之后，紧接着的一次 `tap()` 会被吞掉（不产生 click）。e2e 里手势后要轻点时，松手前先停 200ms，或者改用 `click()`。

## 2026-11-07 19:46 阶段 6 发布与运维决策

- **备份格式**：`lode backup` 输出 tar.gz，内含清单 `lode-backup.json`（格式版本、程序版本、数据库迁移版本、时间）、`app.db`（`VACUUM INTO` 在线快照）、`vault/`、`trash/`。不含 `backups/` 和 `pre-restore-*`，也不含 `LODE_SECRET_KEY`。
- **恢复**：先解包到数据目录内的 `.restore-*` 临时目录并 `quick_check`，通过后才把原数据移到 `pre-restore-<时间>/`，不直接删除。放在数据目录内是因为容器里只有 `/data` 可写，且同一文件系统内 rename 才是原子的。
- **数据目录锁**：`serve` 和 `restore` 对 `dataDir/.lock` 加系统文件锁（unix flock、windows LockFileEx），进程退出自动释放，不会留下陈旧锁。`backup` 不加锁，因为要支持服务运行中备份。
- **迁移前备份**：`db.Open` = `Connect` + 有待执行迁移时复制到 `backups/app-v<旧版本>-<时间>.db`（保留 5 份）+ `Migrate`。全新数据库不备份。运维子命令用 `Connect`，不触发迁移。
- **镜像**：distroless static nonroot（uid 65532），`HEALTHCHECK` 调用 `lode healthcheck` 子命令（distroless 没有 curl/wget）。用 `BUILDPLATFORM` 交叉编译，多架构构建不走 QEMU 跑 Go 编译器。
- **本机没有 Docker**：容器相关验收（compose up、`--memory=256m`、发布二进制在容器里跑）放在 CI 的“容器冒烟”任务里，脚本是 `scripts/docker-smoke.sh`；`web/e2e/container.spec.ts` 只在设置 `LODE_E2E_URL` 时运行，对外部实例跑冒烟。
- **新增依赖**：`golang.org/x/term`（`reset-password` 从终端读密码不回显）；`golang.org/x/sys/windows` 原本就是间接依赖，现在 `internal/ops` 的 Windows 文件锁和 `cmd/bench` 的内存读取直接使用。
- **文件锁不可用**：文件系统不支持加锁（部分 NFS、SMB 挂载）时 `ops.Lock` 返回 `ErrLockUnsupported`，`serve` 打警告继续运行，`restore` 也照常执行；只有锁被别的进程持有才拒绝。
- **本机改动要自己刷新派生数据**：本机删除、恢复、移动笔记后，WebSocket 回声会被 `sync.isKnown` 当成已知而忽略，所以 `stores/vault.ts` 里这些操作要自己调用 `contentChanged()`（递增 `version`，搜索结果、反链等据此刷新）。以前偶尔靠回声先于本地更新到达才刷新，CI 上暴露为 smoke 用例的竞态。
- **性能基准**：`server/cmd/bench`；Windows 的工作集会被系统修剪，内存以 CI（Linux）的 VmRSS 为准。两个字的中文查询走 LIKE 扫描，是搜索 p95 的主要来源。

## 2026-11-07 19:20 阶段 5 评审后的修正

- **模型摘要**：上下文超出时用当前模型压缩较早的轮次（`internal/agent/summary.go`），摘要和覆盖条数存在 `agent_chats.summary`、`summary_upto`（迁移 0004），之后只增量合并新轮次，避免每次请求都重新总结；`Fit` 保留本地规则摘要作为默认和失败兜底，模型版走 `FitWith`。
- **断开即取消**：生成中对话没有任何订阅者时开始计时（默认 30 秒，`Service.DisconnectGrace`），到期取消请求上下文；重新订阅停止计时。宽限时间是为了刷新页面、切网络时不丢掉正在进行的生成。
- **key 末 4 位**：短于 12 个字符的 key 不显示末 4 位（`secret.Last4` 返回空串），否则会泄露大半个 key。
- **手机上的下拉框**：`visual.spec` 要求触屏上所有可点元素不小于 44×44，`select` 也算在内；设置页和输入框下方的下拉框在 `pointer: coarse` 时高度用 `--hit-target`。

## 2026-11-07 19:15 阶段 5 助手决策

- **不用 LLM SDK**：三家都是直接 HTTP + 手写 SSE 解析（`internal/llm`），依赖少、二进制小，流式事件和错误分类统一。入口是 `llm.Stream` 和 `llm.ListModels`，按 `Config.Kind` 分派；新增一种接口时在这两处加分支和对应的适配器文件。
- **API key 加密**：`LODE_SECRET_KEY` → HKDF-SHA256 → AES-256-GCM，密文前缀 `v1:`，AAD 为供应商 id（防止密文被挪到别的记录）。没设主密钥时可以添加不带 key 的供应商（Ollama 等），带 key 的保存返回 400。日志、响应、证据里都不能出现明文 key，API 测试会检查。
- **对话懒创建**：“新对话”只是清空前端状态，第一次发送（或改模型、推理强度）时才在服务端创建，避免产生空对话。
- **事件流断线重连**：SSE 第一条是 `state` 快照。前端每次（重新）连接收到它后重新拉取整个对话，期间到达的事件先缓存、拉取完成后按顺序补上；事件按 rAF 合并，一帧最多渲染一次（`stores/agent.ts`）。服务端订阅通道满了直接断开，让客户端重连补齐，不在服务端排队。
- **Markdown 渲染**：复用编辑器的 `@lezer/markdown` 解析器（GFM + wikilink）把语法树转成 React 元素，原始 HTML 当文本显示，链接只放行 http/https/mailto，图片只显示笔记库内的。流式时每次整段重解析，未闭合的代码块也能正常显示。
- **右栏宽度**：助手标签页时右栏 380px（`--rightbar-width-agent`），宽度用 motion 值弹簧过渡，主区域随之让出空间；手机上助手是 `/agent` 页面，抽屉里不显示助手标签。
- **e2e 命名**：助手用例叫 `talk-to-agent.spec.ts`，字母序在 sync 之后、tokens 之前；不能叫 `agent.spec.ts`（会排在 smoke 前面，破坏首次设置用例）。测试实例的 `LODE_SECRET_KEY` 写在 `playwright.config.ts`。
- **编辑器断言**：实时预览把 `- [x]` 渲染成复选框，e2e 要检查 `.cm-task-checkbox` 的勾选状态，不能找 `[x]` 文本。

## 2026-11-07 18:03 阶段 3 设计与动效决策

- **面板动画**：桌面侧栏展开收起时各栏绝对定位，动画期间只改 transform，稳定后主区域再一次性让出布局（`features/shell/panelMotion.ts`）。静止时 transform 必须归零，否则 CodeMirror 的 fixed 定位提示框会错位。
- **减弱动态效果**：`<MotionConfig reducedMotion="user">` 只跳过动画过程，`initial` 里的缩放和位移仍会在第一帧生效。弹出类组件用 `components/usePop.ts`，减弱时只做透明度变化。
- **touch-action 只算到最近的滚动容器**：抽屉里有滚动区时，滚动区内的横向拖拽会被浏览器接管。所以 `.drawer, .drawer *` 都写 `touch-action: pan-y`。
- **材质变量**：`--material-blur-*` 本身就是完整的 `blur(...) saturate(...)`，直接写 `backdrop-filter: var(--material-blur-thick)`；外面再套 `blur()` 是无效值，毛玻璃会静默失效。
- **colors.css 的覆盖优先级**：高对比度、减弱透明度等覆盖规则要用 `:root, :root[data-theme], :root:not([data-theme='light'])` 这组选择器，否则在暗色主题块面前优先级不够，暗色下不生效。
- **虚拟滚动的键盘导航**：滚动后要 `flushSync` 重新计算渲染范围，再同步聚焦目标行。放到 rAF 里聚焦，连续按键时下一次会从旧行出发，焦点卡住。
- **e2e 规格文件顺序**：Playwright 1 个 worker，按文件名字母序：screenshots < smoke < sync < tokens < touch < visual。visual 的最后一个用例写入 2500 篇笔记，必须保持最后；新规格文件命名时注意这个顺序。
- **触摸测试**：用 CDP `Input.dispatchTouchEvent` 派发真实触摸序列（`e2e/touch.spec.ts`），Playwright 的 `tap()` 只适合点按。
- **格式化**：项目没有配置 prettier，不要运行 `npx prettier`，会把代码改成双引号加分号。

## 2026-11-07 17:21 阶段 4 MCP 决策

- **SDK**：官方 `github.com/modelcontextprotocol/go-sdk` v1.8.0（配套 `github.com/google/jsonschema-go` v0.4.3）。支持的协议版本是 2026-07-28（最新）、2025-11-25、2025-06-18、2025-03-26、2024-11-05。
- **传输**：`mcp.NewStreamableHTTPHandler`，选项 `Stateless: true, JSONResponse: true`。工具调用都是一问一答，不需要会话和服务器推送；`GET /mcp` 由 SDK 返回 405。
- **`DisableLocalhostProtection: true`**：SDK 默认拒绝“经回环地址到达、Host 却不是 localhost”的请求，经 Caddy 等反向代理访问时正好是这种情况。每个请求都必须带 Bearer token，DNS rebinding 拿不到 token，所以关掉是安全的。
- **鉴权**：`sdkauth.RequireBearerToken`，verifier 返回的错误必须包装 `sdkauth.ErrInvalidToken`，否则 SDK 返回 500 而不是 401。没有配置 resource metadata，所以 401 不带 `WWW-Authenticate`。
- **权限**：只读、读写各建一个 `mcp.Server`，`getServer` 按 token 的 scope 选择。只读服务器上根本没有写工具，调用时 SDK 直接返回 “unknown tool”。
- **工具 schema**：用 `jsonschema.For[T]` 从输入结构体生成。
  - 不带 omitempty 的字段是必填；对象默认 `additionalProperties: false`。
  - `jsonschema:"…"` 标签是描述，不能以 `WORD=` 开头，否则会被当作旧语法报错。
  - 指针和切片默认推断成 `["null", T]`，已改为单一类型，部分客户端不认类型数组。
- **挂载**：`/mcp` 直接挂在根 mux 上，不经过 csrf、withActor 和会话检查。REST `/api/*` 暂不接受 Bearer token。
- **actor**：MCP 写入的设备为 `mcp:<token id>`，设备名为 token 名称，复用阶段 2 的变更流，网页端无需刷新就能看到。
- **append**：总是追加到最新版本，不会冲突，`base_rev` 只作记录；需要时补换行，原文用 CRLF 时沿用 CRLF。
- **审计**：`internal/audit` 每次调用记一条，保留最近 1000 条；写审计用 `context.WithoutCancel`，客户端断开也要记下。
- **实测方法**：
  - Claude Code：设置临时 `CLAUDE_CONFIG_DIR` 并用 `--mcp-config … --strict-mcp-config`，不碰用户自己的配置；在 Claude Code 会话里嵌套运行时要删掉环境变量 `CLAUDECODE`。脚本见 `web/scripts/mcp-live-check.mjs`。
  - MCP Inspector：用 `npx @modelcontextprotocol/inspector` 运行外部包被权限策略拒绝，不要再尝试。
  - Windows Git Bash 的 curl 会把 `-d` 参数里的中文按本地代码页转码，请求体含中文时用 `--data-binary @-`。

## 2026-11-07 16:58 阶段 2 服务端同步决策

- **三方合并**：`internal/merge` 自己实现按行的 diff3，不引入依赖。前端的 `web/src/sync/textdiff.ts` 也自己实现了按行 LCS，只用来生成 CodeMirror 的 ChangeSet，不参与冲突判定。
  - 两边的改动范围重叠，或者相邻但结果不同，算冲突。
  - LCS 表上限 `maxCells = 2_000_000`（uint16，约 4MB）。去掉公共前后缀后仍超限，就把整段当作一处改动。这样冲突判定会偏保守，但不会丢内容。
- **冲突副本命名**：`名称.conflict-<设备名>-<yyyyMMdd-HHmmss>.md`，与原笔记在同一目录。格式定义在三处，改一处要同步另外两处：
  - 服务端 `notes/write.go` 的 `conflictPathLocked`；
  - 前端 `sync/engine.ts` 的 `CONFLICT_RE`，它靠"副本由别的设备新建且 rev 为 1"来识别对方产生的冲突；
  - `e2e/sync.spec.ts`。
- **PATCH 的 base 版本已清理**：只返回 409，不生成副本。PATCH 只带片段，没法还原客户端的全文。PUT 则按重叠处理，会生成副本。
- **历史与变更保留**：
  - 每篇笔记保留 `KeepVersions = 50` 版和 `KeepFor = 30 天` 内的版本，超期的只留最新一版，三方合并要用它作 base。
  - 清理掉的最大 seq 记在 meta 的 `changes_floor`。`since` 小于 floor 或大于最新 seq（数据目录被重建）时返回 410。
  - `LatestSeq` 读 `sqlite_sequence`，不用 `MAX(seq)`，这样清理旧事件后序号也不会变小。
  - 前端遇到 410 全量重拉时，以服务器树的 seq 为准，不和本地取较大值，否则重建后每次补齐都会 410。
- **WebSocket**：`coder/websocket` 的 `Accept` 默认校验 Origin 与 Host 一致，用来阻止跨站页面借用会话 cookie。所以反向代理不能改写 Host（见 `docs/dev-https.md`）。
  - 每 30 秒心跳 `{type:"ping", seq}`，客户端 75 秒没收到消息就重连。
  - 订阅通道满了会丢事件，客户端靠心跳里的 seq 发现缺口后补齐。
  - 外部修改（fsnotify、对账）和界面写入走同一条变更流，阶段 4 的 MCP 和阶段 5 的 Agent 写入也复用它。

## 2026-11-07 16:46 阶段 2 前端同步与 PWA

- **同步引擎**（`web/src/sync/engine.ts`）：前端读写笔记的唯一入口。
  - **写队列**：每篇笔记只占一项，后写的覆盖先写的，基于的 rev 保留第一次入队时的值。队列持久化在 IndexedDB 的 `queue` store。
  - **单飞执行**：`drain` 和 `catchUp` 各自同一时间只有一个在跑，执行期间再次调用只设置“再跑一轮”标记。
  - **冲突副本**：本地冲突时，发送期间又产生的修改、以及编辑器里还没交给引擎的修改，都经写队列写进副本，断网也不丢。
  - **回声判定**：判断一条变更是否是自己产生的，用 vault store 里的 rev 和 path，不用 `device_id`。同一台设备的另一个标签页也需要收到这些变更。
- **重连顺序**：`resync()` 先 `catchUp`（遇到 410 就 emit `gone`，并等全量重拉完成），再 `drain` 重放队列。WS 的 `hello` 和浏览器的 `online` 事件都触发 `resync`。拿到笔记树的 seq 之前（`haveSeq`）不补齐，否则会从 0 拉全部变更。
- **编辑器接远端修改**：store 通过组件注册的 `editorBridge`，把远端版本套进 CodeMirror。
  - 用 `diffChangeSet(base, next)`，再按本地修改 `map` 做 rebase；dispatch 时带 `remoteSync` 和 `addToHistory.of(false)`，不进撤销栈。
  - 本地有修改时，rebase 后立即保存。
  - 输入法组字期间（`view.composing`）推迟应用，在 `compositionend` 之后加 `setTimeout 0` 再应用。推迟期间如果触发保存，保存前先把推迟的远端版本 rebase 进要保存的内容。
- **派生数据刷新**：vault store 的 `version` 计数器在内容或结构变化时加一（防抖 300ms），反链、搜索、视图依赖它刷新。原先的 `seq` 和轮询已删除。
- **PWA**：`vite-plugin-pwa` 2.0 的配置是 generateSW、`registerType: 'prompt'`、`navigateFallback: '/index.html'`，denylist 排除 `/api/`。用了 `virtual:pwa-register` 后，pnpm 严格模式下 **`workbox-window` 必须作为直接依赖**，否则 rolldown 解析失败。回到前台时调用 `reg.update()` 检查新版本。
  - 图标用 `node web/scripts/gen-icons.mjs` 重新生成（Playwright 渲染 SVG）。
- **离线冷启动**：`session.check` 遇到网络错误时，如果 IndexedDB 里有缓存的树，就进入 ready。退出登录时 `clearCache()` 清空笔记缓存，但保留写队列。
- **WS 消息字段**：用 snake_case 的 `device_id`，和 REST 的 Change 一致；SPEC 里写的是 `deviceId`，已在 `docs/api.md` 注明。
- **测试经验**：
  - IME 组字用 CDP 的 `Input.imeSetComposition`、`Input.insertText` 模拟，删掉推迟分支后这个测试会失败。
  - SW 状态用 `expect.poll` 等到 `activated`。
  - 引擎单测用 `gated()` 控制请求的进入和放行，不靠 `setTimeout(0)` 的时序。
  - 设了 `LODE_SCREENSHOTS` 跑全量 e2e 时，screenshots.spec 会先完成密码设置，导致 smoke 的首启用例失败。截图只单独跑相关 spec。
  - RSS 测量：`rss.ps1` / `rss.sh` 用 `server/cmd/wsprobe` 保持 2 个 WS 连接（登录返回 204，按 2xx 判断成功）。进程在 finally/trap 里结束，否则会残留并占住 18788 端口。
- **编码**：bash heredoc 里内嵌含中文的 python 脚本会把编码弄坏，改中文内容用 Edit 工具。

## 2026-11-07 16:05 阶段 1 审查后的决策

- **符号链接**：vault 内不跟随符号链接和 Windows 目录联接。`vault.Resolve` 从根逐段 Lstat，遇到 `ModeSymlink|ModeIrregular` 就返回 `ErrInvalidPath`，所有读写都经过它，和 Walk 不索引链接一致。Go 1.23 起 `EvalSymlinks` 不解析目录联接，不能拿它做越界检查。Windows 测试用 `mklink /J` 建联接，不需要管理员权限。
- **反向代理**：`LODE_TRUSTED_PROXIES`（默认 `127.0.0.0/8,::1`）。只有直连方在列表里时才采用 `X-Forwarded-For`（从右往左取第一个不可信地址作为限流键）和 `X-Forwarded-Proto`（决定 cookie 的 Secure）。阶段 6 的 Docker/Caddy 文档要说明：代理不在本机时把代理地址加进去。
- **启动顺序**：先建立 fsnotify 监听（`Watch` 的 ready 回调），再全量对账；关闭时先取消后台任务并等它们结束，再关数据库。
- **已知限制**：外部改名只在同一个对账批次（300ms 合并，最长 1.2s）内按 hash 配对。改名的两个事件落在不同批次时，旧 id 和历史版本会丢，新文件按新建处理。常见编辑器的改名是一次 rename 调用，实际很少触发。
- **前端自身操作改写了打开中的笔记**（重命名时改写链接）：`editor.syncServerNotes` 会重新载入它。轮询会过滤本机设备的变更，不能靠轮询发现。

## 2026-11-07 15:55 阶段 1 决策

- **Go 版本**：`go.mod` 声明 go 1.26.0。modernc sqlite 和 x/crypto 的当前版本要求 ≥1.26，比阶段说明里的 1.22 高；本地是 1.27。Dockerfile（阶段 6）要用 1.26 以上的镜像。
- **回收站位置**：放在 `DATA_DIR/trash`，不在 vault 里，避免被 Obsidian、同步盘看到。删除文件夹时，其中的笔记逐篇进回收站，非笔记文件整体移到 `trash/folders`。
- **id 只存在数据库**：不写进 frontmatter。外部改名靠内容 hash 匹配"同一批对账里消失的旧路径"来保留 id，hash 不同则当作删除加新建。
- **外部修改感知**：fsnotify 事件先合并 300ms（最长 1.2s）再对账；启动时全量对账。阶段 1 的前端每 1s 轮询 `/api/changes`，阶段 2 换成 WebSocket 后保留该接口用于断线补齐。
- **SQLite**：WAL、`cache_size(-2000)`、最多 4 个连接。1000 篇笔记空闲 WorkingSet 18.6MB，私有内存 52.4MB（Windows 实测，见 `docs/evidence/stage-1/rss.txt`）。
- **鉴权**：argon2id，m=19MiB、t=2、p=1，32 字节；会话 30 天、每次使用顺延；同一 IP 1 分钟内 5 次错误锁定 60s，锁定期间正确密码也返回 429。
- **搜索**：FTS5 trigram；少于 3 个字符的词改用 LIKE；bm25 标题权重 10。snippet 用 `\x02`/`\x03` 标记命中，前端拆分后高亮，避免 HTML 注入。
- **标签规则前后端各一份**：后端 `mdparse` 和前端 `wikilinkSyntax.ts` 的 HashTag 边界字符、标签字符必须保持一致，改一边要改另一边（各有单测）。
- **编辑器**：CodeMirror 6 + 自定义 Lezer 扩展（WikiLink/WikiEmbed/HashTag/Frontmatter）。Frontmatter 只在文档第 1 行是 `---` 且下一行像 YAML 键时识别，否则开头的 `---` 仍是分隔线。外层 `.editor-scroll` 负责滚动，CM 的 scroller 设为 overflow visible，标题才能和正文一起滚动。
- **保存与冲突**：每篇笔记的 rev 存在编辑器 store 的 `revs` 里；自动保存 500ms、同一时间只有一个请求在途、组字期间不保存。收到远端变更时，本地没有未保存修改就用最小差异替换正文（带 `remoteSync` 注解，不触发保存），有修改就显示"已在别处被修改"提示条，不自动覆盖。
- **文件树排序**：`Intl.Collator(['zh-Hans-CN','en'], {numeric:true})`，中文按拼音、数字按数值。
- **构建脚本**：`build.sh` 用 `go env GOEXE` 决定输出名，Windows 下是 `bin/lode.exe`。在 bash 里不要用 `powershell -File scripts/*.ps1`（执行策略会拦），直接用 `.sh`。

## 2026-11-07 15:55 测试经验

- **Playwright 选 CodeMirror 补全项**：补全弹出后约 75ms 内（`interactionDelay`）按 Enter 会被当成换行。测试里先等补全项可见，再 `waitForTimeout(150)` 后按 Enter。
- **Playwright 数据目录**：`web/.e2e-data` 只在主进程清理（`!process.env.TEST_WORKER_INDEX`），worker 里删除会因服务进程占用文件报 EPERM。设 `LODE_E2E_KEEP=1` 可保留数据排查。
- **Windows 下 curl 输出中文会乱码**：证据文件里有中文的行用脚本写入，不要用 `curl -w` 拼中文。

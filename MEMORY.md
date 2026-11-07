# MEMORY

跨任务复用的开发决策与经验，按时间降序。

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

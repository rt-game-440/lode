# AGENTS.md

## 项目

Lode：自托管、单用户的 Markdown 笔记 PWA，多端即时同步，自带 Agent 助手并对外提供 MCP。完整规格见 [docs/SPEC.md](docs/SPEC.md)。

开发分 7 个阶段，阶段 1–6 对应 GitHub issue #1–#6，阶段 7（多工作空间，设计见 [docs/workspaces.md](docs/workspaces.md)）对应 #54，因为 #7 已被占用；标签都是 `stage`，依赖关系见 SPEC 的"阶段"表。issue 正文就是该阶段的任务说明，同一份内容也存在 `docs/stages/stage-<N>.md`。

## 开始一个阶段

1. 读 `docs/SPEC.md`、本文件、`docs/progress.md` 和 `MEMORY.md`（后两者存在时）。
2. 用 `gh issue view <N>` 确认本阶段依赖的 issue 都已关闭；有未关闭的就停下汇报。
3. 从最新的 main 拉出分支 `stage-<N>-<短名>`，在分支上开发。

例外：阶段 7（多工作空间）的 issue 是 #54（#7 已被占用），它的子 issue 是 #56–#64；上面的 `<N>` 对阶段 7 取 54，任务说明仍在 `docs/stages/stage-7.md`。

## 权限

- 可以：本地提交、推送本阶段分支、开 PR（正文写 `Closes #<issue 编号>`）、安装项目依赖、执行 `npx playwright install chromium`。
- 先问再做：合并 PR、直接改 main、删除分支、打 tag 或发版、修改仓库设置。
- 先问再做：更换 SPEC 里的技术栈、引入 CGO、改变"文件为真相源"、让已有 API 不向后兼容。
- 其余库和目录细节自行决定，决定写进 `MEMORY.md`（每条带精确到分钟的时间，按时间降序）。

## 进度与续接

- 进度写在 `docs/progress.md`，按阶段分节，写已完成、进行中和下一步，下次会话可以从这里接着做。
- 稳定的项目规则和常用命令写在本文件；只在它们变化时更新。

## 验证

- 每条验收标准都要有证据：命令输出、测试名、截图路径或录屏路径。
- 同一个验证失败最多修 3 轮，仍失败就停下汇报。测试或验收标准本身写错了就直接指出，不要为了通过而改坏逻辑。
- 验收分级：
  - 能自动判定的写成测试；
  - 界面效果需要人看但不需要人操作的（3 级），截图或录屏后用 telegram-push 推送，每项附编号、内容、预期效果；
  - 需要人上手操作的（4 级），追加到 `docs/checklist/stage-<N>.md`：每条带复选框、操作说明、预期效果，留空的"用户反馈"。

## 汇报格式

- 改动摘要；
- 每条验收标准的结果和证据；
- 未解决的问题；
- 做过的假设；
- PR 链接。

## 常用命令

每个脚本都有 `.sh` 和 `.ps1` 两个版本，参数相同（PowerShell 用 `-E2E` 这类写法）。

- 开发：`scripts/dev.sh`，Go 服务在 127.0.0.1:8787（数据在 `data-dev/`，日志在 `logs/`），Vite 在 5173 并代理 `/api`。
- 构建：`scripts/build.sh`，先构建前端再嵌入，输出 `bin/lode`（Windows 为 `bin/lode.exe`）。运行：`bin/lode serve`，配置见环境变量 `LODE_ADDR`、`LODE_DATA_DIR`、`LODE_LOG_LEVEL`、`LODE_TRUSTED_PROXIES`、`LODE_SECRET_KEY`（可选，加密助手 API key 的主密钥，`openssl rand -base64 32` 生成；不设置则自动生成数据目录里的 `secret.key`，设置了则优先使用；更换主密钥后已存的 key 失效）。`lode backup` 默认包含 `secret.key`（`--no-secret` 可排除），`restore` 会恢复它；备份文件等同于含有 API key，请妥善保管。
- 测试：`scripts/test.sh` 跑 Go 单测和前端单测；`scripts/test.sh --e2e` 再构建并跑 Playwright。
  - 单独跑：`cd server && go test ./...`、`pnpm -C web test`、`pnpm -C web typecheck`、`pnpm -C web e2e`（需要先构建 `bin/lode`）。
  - Playwright 启动的测试实例在 18787 端口，数据在 `web/.e2e-data/`，每次运行前清空。
  - 规格文件按文件名字母序串行执行（1 个 worker）。`visual.spec`（axe、reduced motion、三种宽度布局、2500 篇笔记虚拟滚动）会写入大量笔记，必须排在最后；`touch.spec` 用 CDP 派发触摸手势；`talk-to-agent.spec` 内置模拟的 OpenAI 兼容服务，跑助手完整流程，需要排在 smoke 之后（首次设置）；`split-view.spec` 逐帧采样桌面侧栏 / 右栏展开收起（按钮可见、正文无跳变、中途反向、拖拽调宽、减弱动态效果），同样排在 smoke 之后；`ui-agent-popup.spec` 测笔记页的助手弹窗（桌面浮层、手机底部半屏面板的拖动、关闭、内容不丢、减弱动态效果），会临时建一个无 key 的供应商并在结束时清理，排在 smoke 之后。`ui-workspace-external.spec`（#60 外部目录工作空间：新建对话框的路径校验提示、接入已有目录对账、外部与 Lode 交叉编辑、删除不动外部文件）自己启动 `bin/lode`（系统临时目录、随机端口）和一个临时的外部目录，不依赖公共测试实例的状态。`ui-passkey-protect.spec`（#29 用通行密钥保护 API key）自己启动一个不带 `LODE_SECRET_KEY` 的 `bin/lode`（系统临时目录、随机端口），用 `hasPrf` 虚拟认证器覆盖开启、重启锁定、登录解锁和关闭，不依赖公共测试实例的状态。`ui-workspace-agent.spec`（#61 助手按工作空间隔离）同样自己启动 `bin/lode`（临时目录、随机端口、`LODE_SECRET_KEY`）和模拟的 OpenAI 兼容服务，覆盖新空间里对话建笔记、对话列表隔离、在 A 空间生成时切到默认空间。`ui-workspaces.spec`（#58 切换工作空间）会在公共测试实例里新建一个工作空间，第一个用例要求此前只有默认工作空间，排在 smoke 之后、visual 之前；覆盖只有默认空间时原有地址不变、新建切换后笔记隔离、A 空间离线编辑切走再切回后补发、两个标签页各开一个空间互不收到变更。`ui-workspace-settings.spec`（#59 设置页管理工作空间、token 绑定空间）会新建几个空间，结束时（含失败）全部删除并把默认空间名改回去，因为 `ui-workspaces.spec` 要求此前只有默认空间；它的文件名排在后者之前。`ui-reading-position.spec`（#71 回到上次的浏览位置：切换 / 刷新后按“视口顶端是哪一行”比较、光标恢复、手机宽度不聚焦、点大纲以目标为准、位置超出文档长度）不新建工作空间，排在 smoke 之后。`ui-settings-dialog.spec`（#74 桌面设置浮窗：浮窗下笔记页和滚动位置不变、Esc / 遮罩 / 关闭按钮、地址与后退、二级确认框 Esc 只关最上层、手机仍是全屏页、axe 亮暗）不新建工作空间，排在 smoke 之后；设 `LODE_SCREENSHOTS` 时另截浮窗图。`ui-workspace-transfer.spec`（#72 在工作空间之间移动、复制）同样自己启动 `bin/lode`（临时目录、随机端口），覆盖右键菜单复制带图笔记、移动文件夹、离线禁用、拖到工作空间切换器移动、Alt 复制、Esc 取消；截图用 `LODE_SCREENSHOTS=issue-72`。
  - `pnpm -C web test` 里的 `tokens.lint.test.ts` 检查组件没有硬编码颜色和动画时长，规则见 [docs/design.md](docs/design.md)。
- 截图：`LODE_SCREENSHOTS=stage-<N> pnpm -C web e2e screenshots`，输出到 `docs/screenshots/stage-<N>/`。同步相关截图（离线、冲突）用 `LODE_SCREENSHOTS=stage-<N> pnpm -C web e2e sync`。手势录屏加上 touch：`LODE_SCREENSHOTS=stage-<N> pnpm -C web e2e screenshots touch`，录屏输出到 `video/`（webm，需要时用 ffmpeg 转 mp4）。工作空间切换器和设置页分区（三种宽度）：`LODE_SCREENSHOTS=stage-7 pnpm -C web e2e screenshots -g 工作空间`。设了这个变量时不要跑全量 e2e：screenshots.spec 会先完成密码设置，导致 smoke 的首启用例失败。
- PWA 图标：`node web/scripts/gen-icons.mjs` 从 SVG 重新生成 `web/public/` 下的图标。
- 手机测试（局域网 HTTPS）：见 [docs/dev-https.md](docs/dev-https.md)。
- 内存：`scripts/rss.sh`（需先构建），生成 1000 篇笔记、重启对账后用 `server/cmd/wsprobe` 保持 2 个 WebSocket 连接（`WS=` / `-WebSockets` 可改），再测量空闲 RSS 并打印结果；PowerShell 版加 `-Out docs/evidence/stage-<N>/rss.txt` 直接写证据文件。`WORKSPACES=K`（PowerShell `-Workspaces K`）额外建 K 个空间各 N 篇并全部打开，上限放宽到 80MB。
- MCP 实测（需先构建）：`node web/scripts/mcp-live-check.mjs` 起独立实例（18788 端口，数据在 `data-live4/`），用本机 Claude Code 经 MCP 搜索 → 读取 → 追加，并截图；`bash web/scripts/mcp-curl-check.sh` 实测 `docs/mcp.md` 里的 curl 示例。证据写到 `docs/evidence/stage-4/`。
- 助手：`LODE_SCREENSHOTS=stage-5 pnpm -C web e2e talk-to-agent` 录屏助手流程（`docs/screenshots/stage-5/video/`）。真实供应商冒烟：设置 `LODE_TEST_OPENAI_KEY`、`LODE_TEST_ANTHROPIC_KEY`、`LODE_TEST_GEMINI_KEY` 中的任意几个（可选 `LODE_TEST_*_MODEL`、`LODE_TEST_*_BASE_URL`）后运行 `cd server && go test ./internal/llm -run Live -v`，没设置的跳过。
- 生成测试笔记：`cd server && go run ./cmd/gennotes -dir <vault目录> -n 1000`。
- 运维：`bin/lode backup <文件.tar.gz> [--workspace <id>] [--no-secret]`（运行中可执行；默认备份全部工作空间，含外部目录的笔记和清单里的原路径，`--workspace` 只备份一个）、`bin/lode restore <文件> [--external-to <目录>] [-y]`（需先停服；完整备份恢复全部，外部目录恢复到原路径、非空则拒绝，`--external-to` 改恢复到 `<目录>/<id>` 并更新登记路径；单空间备份只替换那一个空间；阶段 6 旧备份按只有默认空间恢复）、`bin/lode reset-password [--clear-passkeys]`、`bin/lode healthcheck`、`bin/lode workspace list [--json] | add <名称> [--dir <绝对路径>] | rename <id> <名称> | remove <id>`（管理工作空间，需先停服；`--dir` 把已有文件夹接入为外部工作空间，`remove` 外部空间只删索引、不动笔记文件）。部署、升级、备份恢复见 [docs/deploy.md](docs/deploy.md)。
- 备份恢复冒烟：`scripts/backup-smoke.sh [lode 路径]`（PowerShell `scripts/backup-smoke.ps1 [-Bin ...] [-Out 证据文件]`，需先构建）起真实服务，建内置和外部工作空间，备份、清空、恢复，覆盖拒绝覆盖非空外部目录、`--external-to`、单空间恢复、阶段 6 旧格式；失败时退出码非零。证据：`docs/evidence/stage-7/backup-restore.txt`。
- 发布：`scripts/release.sh [版本]` 交叉编译 6 个平台到 `dist/`（含 `SHA256SUMS`），`SKIP_WEB=1`（PowerShell `-SkipWeb`）跳过前端构建。推送 `v*` tag 触发 `.github/workflows/release.yml`（打 tag 发版要先问）。
- 容器冒烟：`scripts/docker-smoke.sh`（需要 Docker，本机没有时看 CI 的“容器冒烟”任务）；对任意运行中的实例跑冒烟：`LODE_E2E_URL=http://127.0.0.1:8787 pnpm -C web e2e container`（实例必须是未设置密码的全新数据）。
- 性能基准：先构建，再 `cd server && go run ./cmd/bench -bin ../bin/lode -n 1000,10000`，输出 Markdown 表格，结果记在 [docs/benchmark.md](docs/benchmark.md)。
- 接口文档：[docs/api.md](docs/api.md)；MCP 接入：[docs/mcp.md](docs/mcp.md)。

## Agent skills

### Issue tracker

issue 和规格放在 GitHub Issues（rt-game-440/lode），用 `gh` 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录一个 `GLOSSARY.md` 加 `docs/adr/`（都在用到时才创建）。见 `docs/agents/domain.md`。

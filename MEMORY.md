# MEMORY

跨任务复用的开发决策与经验，按时间降序。

## 2026-11-07 15:55 阶段 1 决策

- **Go 版本**：`go.mod` 声明 go 1.26.0。modernc sqlite 和 x/crypto 的当前版本要求 ≥1.26，比阶段说明里的 1.22 高；本地是 1.27。Dockerfile（阶段 6）要用 1.26 以上的镜像。
- **回收站位置**：放在 `DATA_DIR/trash`，不在 vault 里，避免被 Obsidian、同步盘看到。删除文件夹时，其中的笔记逐篇进回收站，非笔记文件整体移到 `trash/folders`。
- **id 只存在数据库**：不写进 frontmatter。外部改名靠内容 hash 匹配"同一批对账里消失的旧路径"来保留 id，hash 不同则当作删除加新建。
- **外部修改感知**：fsnotify 事件先合并 300ms（最长 1.2s）再对账；启动时全量对账。阶段 1 的前端每 1s 轮询 `/api/changes`，阶段 2 换成 WebSocket 后保留该接口用于断线补齐。
- **SQLite**：WAL、`cache_size(-2000)`、最多 4 个连接。1000 篇笔记空闲 WorkingSet 17.9MB，私有内存 52.2MB（Windows 实测，见 `docs/evidence/stage-1/rss.txt`）。
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

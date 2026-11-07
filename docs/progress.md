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
- Windows 私有内存 52.2MB（WorkingSet 17.9MB 达标），Linux 上的 RSS 待阶段 6 Docker 镜像里复测。

下一步：阶段 2（多端即时同步，WebSocket 替换轮询）。

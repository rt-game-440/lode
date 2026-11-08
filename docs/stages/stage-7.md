# 阶段 7：多工作空间

依赖：阶段 6（#6，间接依赖全部前序阶段）。开始前按 `AGENTS.md` 的"开始一个阶段"执行，共同约定见 `docs/SPEC.md`。分支名 `stage-7-workspaces`。

设计文档：[docs/workspaces.md](../workspaces.md)。数据布局、接口、取舍和任务拆分都以它为准，本文件只写范围和验收。

目标：在一个实例里管理多个互相隔离的笔记库，在界面里随时切换；只需登录一次，助手供应商只需配置一次；已有部署升级后不需要做任何事。

## 范围内

### 服务端

- 迁移 0006：`workspaces` 登记表，`api_tokens.workspace_id`、`audit_log.workspace_id`。现有的 `data/vault` 和 `app.db` 原地成为默认工作空间（id `default`），不搬迁文件。
- 新工作空间放在 `data/workspaces/<id>/`，有自己的 `index.db`（和 `app.db` 跑同一套迁移）、`vault/`、`trash/`。
- 外部目录：vault 可以指向一个已有的绝对路径，外部目录里只放笔记文件。路径不能和数据目录或已有 vault 相同或互相嵌套。
- `internal/workspace` Manager：按需打开（建监听 → 对账）、关停、加锁。
- 助手：供应商、模型、设置保持全局；对话按工作空间存放，工具调用只作用于当前工作空间。
- API：原有 `/api/...` 表示默认工作空间；按工作空间的路由同时挂到 `/api/w/{ws}/...`；新增 `/api/workspaces` 增删改查。
- MCP：token 绑定工作空间，`/mcp` 只能访问 token 绑定的那个空间。
- 删除：默认工作空间不可删除；内置目录整体移到 `data/trash-workspaces/`；外部目录只删索引，不动笔记文件。
- 运维：`lode backup` 默认包含全部工作空间（包括外部 vault），支持 `--workspace`；`lode restore` 兼容旧版备份，外部路径冲突时拒绝并提示 `--external-to`；新增 `lode workspace list|add|rename|remove`。

### 前端

- 默认工作空间的 URL 不变，其他工作空间用 `/w/<id>/...`；API 客户端自动加前缀。
- 同步引擎和 IndexedDB 按工作空间实例化（默认工作空间仍叫 `lode`，其他叫 `lode:<id>`），离线写队列各自保留。
- `lode.recent`、`lode.expanded`、`lode.agent.chat` 按工作空间存；主题、布局、字号、编辑器偏好保持全局。
- 侧栏顶部加工作空间切换器，命令面板加“切换工作空间”，设置页加“工作空间”分区（重命名、排序、删除、查看路径）；创建 MCP token 时可以选择工作空间。

### 文档

- SPEC 补一节“工作空间”，阶段表加上阶段 7（修改 SPEC 的理由：新增的功能跨越存储、API、同步和 MCP，需要写进共同约定）。
- 更新 `docs/api.md`、`docs/mcp.md`、`docs/deploy.md`（外部目录在容器里要另外挂卷）、`AGENTS.md` 常用命令、`CHANGELOG.md`。

## 范围外

多用户和按工作空间分配权限、跨工作空间的链接、搜索或移动笔记、一篇笔记同时属于多个工作空间。

## 保持不变

已有 API 完全向后兼容；已有 MCP token 继续可用，默认属于默认工作空间；已有测试继续通过；只有一个工作空间时，界面和现在基本一样。

## 验收标准

1. Go 测试：用旧版 `app.db` 升级后结构正确，且和新建的 `index.db` 同构；两个空间里同路径的笔记互不影响；`/api/...` 和 `/api/w/default/...` 结果一致；未知 id 返回 404；绑定 A 空间的 MCP token 读不到 B 空间；外部路径相同或嵌套时拒绝创建；删除外部工作空间后外部文件完好；backup/restore 往返（包括旧版备份和外部 vault）。
2. 前端单测：API 前缀拼接；localStorage 键和 IndexedDB 名称按工作空间区分。
3. Playwright（新 spec，排在 smoke 之后）：新建工作空间 → 写笔记 → 切回默认空间看不到 → 再切回来笔记还在；在 A 空间离线编辑，切到 B 再切回 A、恢复网络后写队列补发成功；两个标签页分别打开两个空间，各自实时同步。
4. 内存：只有默认工作空间时，1000 篇笔记的空闲 RSS 和阶段 6 相比增加不超过 2MB；3 个工作空间各 1000 篇且都已打开时，空闲 RSS ≤ 80MB。证据写到 `docs/evidence/stage-7/`。
5. 截图（3 级，推送到 Telegram）：侧栏切换器和设置页工作空间分区，在三种宽度下各截一张，输出到 `docs/screenshots/stage-7/`。
6. 写入 `docs/checklist/stage-7.md`（4 级）：在手机 PWA 上切换工作空间；把一个已有的 Obsidian 库接入为外部工作空间，并在 Obsidian 和 Lode 里交叉编辑。
7. 本阶段的 PR 上 CI 全绿。

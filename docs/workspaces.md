# 多工作空间设计

状态：已实现（阶段 7，父 issue #54，2026-11-09）。以下按实现更新；与最初草案的出入：JSON 字段统一用 snake_case（`vault_dir`、`created_at`、`note_count`），工作空间列表另有 `path`；管理接口里工作空间不存在返回 `404 not_found`，`workspace_not_found` 只用于 `/api/w/<id>/...`；`--external-to` 是父目录，外部空间恢复到 `<目录>/<id>`。接口细节见 [api.md](api.md)，运维见 [deploy.md](deploy.md)。

## 1. 目标

在一个 Lode 实例里管理多个互相隔离的笔记库（工作空间），比如“个人”“工作”“读书”，在界面里随时切换。

要做到：

- 每个工作空间是一个普通文件夹，里面是 Markdown 文件，“文件为真相源”不变，能直接用 Obsidian 打开。
- 只登录一次，助手的供应商和 API key 只配置一次。
- 笔记、搜索、标签、反链、回收站、历史版本、同步、助手对话、MCP 访问都按工作空间隔离，互相看不到。
- 已有部署升级后不需要做任何事：现有的 `data/vault` 自动成为“默认工作空间”，现有 API、链接、PWA、MCP token 照常可用。

不做：

- 多用户、按工作空间分配权限（SPEC 规定单用户）。
- 跨工作空间的链接、搜索、移动笔记（移动可以以后用“导出 + 导入”补）。
- 一篇笔记同时属于多个工作空间。

## 2. 现状

以下根据当前 main（a99c948）整理：

- 数据目录在 `config.Config` 中只解析一次：`VaultDir()`、`TrashDir()`、`DBPath()`，在 `cmd/lode/main.go` 中装配。
- `notes.Service` 实际上就是“一个工作空间”：它持有 vault、回收站目录、数据库，负责文件监听（`Watch`）、启动对账（`Reconcile`）、变更订阅（`Subscribe`，WebSocket 推送就是靠它），还负责历史版本清理。
- `api.Server.Notes`、`agent.Service.Notes`、`tools.New(svc)`（MCP 和助手共用的工具注册表）都只绑定了一个 `notes.Service`。
- `app.db` 里的表分两类：
  - 笔记索引：`notes`、`notes_fts`、`links`、`tags`、`folders`、`versions`、`changes`、`trash`；
  - 全局：`settings`（密码哈希等）、`sessions`、`passkeys`、`api_tokens`、`audit_log`、`llm_providers`、`llm_models`、`agent_settings`；
  - 助手对话：`agent_chats`、`agent_messages`、`agent_pending`。其中 `agent_messages` 和 `agent_pending` 有外键指向 `agent_chats`，这三张表必须放在同一个库里。
- 前端：IndexedDB 由 `sync/localdb.ts` 的 `LocalDB(name = 'lode')` 打开，存笔记树快照、正文缓存和写队列；localStorage 里有 `lode.recent`、`lode.expanded`、`lode.agent.chat`、`lode.layout`、`lode.theme` 等。
- `ops.Lock(dataDir)` 给整个数据目录加锁；`lode backup` 打包 `app.db`、`secret.key`、`vault/`、`trash/`。
- 内存目标（SPEC）：1000 篇笔记空闲 RSS ≤ 50MB。

## 3. 数据布局

```
data/
  app.db              全局库 + 默认工作空间的索引（沿用，不搬迁）
  secret.key
  vault/              默认工作空间（id = default）
  trash/
  workspaces/
    <id>/
      index.db        该工作空间的索引和助手对话
      vault/          内置位置的笔记（创建时选“放在数据目录里”）
      trash/
```

- 工作空间 id：创建时生成的短 id（小写字母和数字，例如 `k3f9a2`），之后不再改变；名称可以随时改。`default` 是保留 id。
- **外部目录**：创建时可以把 vault 指向一个已有的绝对路径（比如已有的 Obsidian 库）。这时 vault 在外部，`index.db` 和 `trash/` 仍放在 `data/workspaces/<id>/` 下，不往用户目录里写任何东西。
- 工作空间登记在全局库的新表里：

```sql
CREATE TABLE workspaces (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    vault_dir  TEXT    NOT NULL DEFAULT '', -- 空表示 data/workspaces/<id>/vault；否则是外部绝对路径
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
-- 迁移时插入 ('default', '笔记', '', 0, now)，默认工作空间的 vault_dir 固定指向 data/vault。
```

### 为什么每个工作空间一个库，而不是加 `workspace_id` 列

| | 每个工作空间一个 `index.db`（采用） | 所有表加 `workspace_id` |
|---|---|---|
| 改动面 | `notes` 包基本不动，只是打开另一个库 | `notes` 包里每条 SQL 都要加条件；`path`、`pkey` 的唯一约束、FTS、`changes.seq` 都要改 |
| 隔离 | 物理隔离，不会因为漏写条件串数据 | 漏写一处就串 |
| 删除工作空间 | 删一个文件 | 多表级联删除 |
| 代价 | 默认工作空间的索引仍在 `app.db`，每个库都要跑迁移 | 无 |

迁移不拆分：`db.Migrate` 用一个递增的整数版本号，而 `0001_init.sql` 里本来就混着全局表和笔记表，拆开要改已经发布过的迁移。所以 `index.db` 和 `app.db` 跑**同一套**迁移。`index.db` 里会多出几张空的全局表（`sessions`、`passkeys` 等），代码从来不读它们。这样做的好处是两种库永远同构，以后的迁移只写一份。

代价是：只涉及全局表的迁移也会在每个 `index.db` 上执行一遍。这本来是空操作，但迁移里不能写依赖全局表里有数据的语句（比如从 `settings` 读值再回填）。这条约定写进 `db` 包的注释。

新增的 `workspaces` 表放在下一个迁移里（0006），同样会在 `index.db` 里建一张空表。实现时先写测试：拿当前版本的 `app.db` 升级后，结构和新建的 `index.db` 一致。

## 4. 哪些全局、哪些按工作空间

| 全局 | 按工作空间 |
|---|---|
| 密码、会话、通行密钥、API key 保护 | vault、回收站、历史版本 |
| 助手供应商、模型、`agent_settings`、`secret.key` | 搜索、标签、反链、文件夹 |
| 外观、主题、布局（前端本机） | 变更序号 `changes.seq`、WebSocket 推送 |
| 审计日志（新增 `workspace_id` 列） | 助手对话、待审批操作 |
| | MCP token（每个 token 绑定一个工作空间） |
| | 最近打开、文件树展开状态、当前对话（前端本机） |

## 5. 服务端结构

新增 `internal/workspace` 包：

```go
type Workspace struct {
    ID, Name string
    Notes    *notes.Service
    Tools    *tools.Registry
    Chats    *agent.ChatStore   // 对话表在 index.db（默认工作空间在 app.db）
    // 内部：DB、后台任务的 cancel 和 WaitGroup
}

type Manager interface {
    Get(ctx, id string) (*Workspace, error) // 第一次访问时打开：打开库、迁移、启动监听和对账
    List(ctx) ([]Info, error)
    Create(ctx, CreateOptions) (Info, error)
    Rename / Reorder / Remove(...)
    Close()                                  // 关停所有已打开工作空间的后台任务
}
```

- **按需打开**：启动时只打开默认工作空间（和现在一样）。其他工作空间在第一次请求时打开，打开时先建监听再全量对账，这和现在 `main.go` 里的顺序一致。打开后一直保持，直到进程退出。理由：每多一个打开的工作空间就多一个 fsnotify 监听和一个 SQLite 连接池，不访问就不占内存。
- **加锁**：`ops.Lock` 继续锁整个数据目录。外部 vault 在 `data/workspaces/<id>/` 下加锁，不往外部目录写锁文件。两个 Lode 实例同时指向同一个外部 vault 的情况无法完全阻止，文档里写明。
- **路径校验**（创建或修改外部目录时）：必须是已存在的绝对路径；不能与数据目录或任何已有 vault 相同，也不能互相嵌套；不能是盘符根目录或用户主目录本身。
- **助手**：`agent.Store` 拆成两部分：全局的供应商、模型和设置（仍在 `app.db`），以及按工作空间的 `ChatStore`。`agent.Service` 处理一次生成时从 `Workspace` 取 `Notes`、`Tools`、`Chats`，正在生成的任务记在对应的工作空间名下。
- **历史清理和会话清理**：历史清理对每个已打开的工作空间各跑一次，会话清理仍是全局一次。

## 6. HTTP API

保持向后兼容：现有路径一律表示默认工作空间。

- 按工作空间的路由同时挂两份：`/api/<原路径>`（默认工作空间）和 `/api/w/{ws}/<原路径>`。
  涉及：`notes*`、`tree`、`folders*`、`search`、`tags*`、`images`、`files/*`、`attachments`、`trash*`、`changes`、`ws`、`agent/chats*`。
- 全局路由不变：`auth/*`、`passkeys*`、`tokens*`（新增可选字段 `workspace`）、`audit`（新增 `workspace` 筛选）、`agent/providers*`、`agent/models*`、`agent/settings`、`agent/config`、`key-protection*`、`health`。
- 新增：
  - `GET /api/workspaces` → `{"workspaces":[{id, name, external, vault_dir, sort, created_at, note_count}]}`（`vault_dir` 只对外部目录返回；字段沿用现有接口的 snake_case）
  - `POST /api/workspaces` `{name, vault_dir?}` → 201，新建的工作空间
  - `PATCH /api/workspaces/{id}` `{name?, sort?}`
  - `DELETE /api/workspaces/{id}`：见第 9 节
- 实现：用一个中间件解析 `{ws}`，交给 `Manager.Get`，把结果放进 request context；处理函数改成从 context 取工作空间，不再读 `s.Notes`。id 不存在时返回 `404 {"error":"workspace_not_found"}`。
- `docs/api.md` 补充一节说明前缀规则，其余接口文档不需要逐条重写。

## 7. MCP

- `api_tokens` 新增 `workspace_id TEXT NOT NULL DEFAULT 'default'`，已有 token 自动属于默认工作空间。
- `/mcp` 不变：先按 Bearer token 找到它绑定的工作空间，再用该工作空间的 `Tools`。外部 Agent 只能访问 token 绑定的那个空间，不提供跨空间的工具。
- 设置页创建 token 时多一个“工作空间”下拉框，默认是当前工作空间。

## 8. 前端

- **路由**：默认工作空间不加前缀，保持现有 URL（PWA 的 `start_url`、书签、分享链接都不变）；其他工作空间用 `/w/<id>/...`。API 客户端根据当前工作空间自动加 `/api/w/<id>` 前缀。
- **本地存储**：
  - IndexedDB：默认工作空间沿用 `lode`，其他用 `lode:<id>`。`LocalDB` 本来就接受 name 参数，同步引擎按工作空间实例化，切换时销毁旧的引擎和 WebSocket 再建新的。离线写队列各自保留，切回来时继续补发。
  - localStorage：`lode.recent`、`lode.expanded`、`lode.agent.chat` 改成按工作空间存（默认工作空间沿用原键名，其他加 `:<id>` 后缀）；主题、布局、字号、编辑器偏好保持全局。
- **切换入口**：
  - 侧栏顶部显示当前工作空间名，点击弹出列表：切换、新建、管理；
  - 命令面板加“切换工作空间”；
  - 设置页加“工作空间”分区：重命名、拖动排序、删除、查看路径。
  - 只有一个工作空间时，侧栏顶部只显示名称和一个不显眼的“新建”入口，界面和现在基本一样。
- **助手**：对话列表只显示当前工作空间的对话，`@` 补全也只补当前工作空间的笔记。

## 9. 删除工作空间

- 默认工作空间不能删除，只能改名。
- 删除其他工作空间：先停掉它的后台任务、关闭库，再从登记表移除，并作废绑定它的 MCP token。
  - 内置目录：整个 `data/workspaces/<id>/` 移到 `data/trash-workspaces/<id>-<时间>/`，不直接删除，提示用户可以手动清理；
  - 外部目录：只删 `data/workspaces/<id>/`（索引、回收站、对话），**外部的笔记文件一个都不动**。
- 前端确认框写清楚会发生什么，外部目录的情况要明确写“不会删除你的笔记文件”。

## 10. 运维命令

- `lode backup`：默认备份全部工作空间。清单里列出每个工作空间；外部目录的 vault 也打包进去，并在清单里记下原路径。新增 `--workspace <id>`，只备份一个。
- `lode restore`：恢复全部；外部 vault 恢复到原路径，原路径已存在且非空时拒绝恢复，要求用 `--external-to <目录>` 指定新位置。旧版备份（没有工作空间信息）按“只有默认工作空间”处理。`--external-to <目录>` 是父目录，每个外部工作空间恢复到 `<目录>/<id>`。单空间备份（`--workspace`）恢复时只替换那一个空间，语义见 [deploy.md](deploy.md) 的“恢复多个工作空间”。
- 新增 `lode workspace list|add <名称> [--dir <路径>]|rename|remove`，方便无界面部署时使用，需要停服后执行（和 `restore` 一样）。
- `reset-password`、`healthcheck` 不变。

## 11. 安全和资源

- 外部目录只能由已登录用户通过界面或 CLI 设置，路径规则见第 5 节；容器部署需要另外挂载卷，`docs/deploy.md` 补充说明。
- 内存：每个打开的工作空间要多占一个 SQLite 连接、一个监听器和一份笔记树。验收时用 `scripts/rss.sh` 的思路测量：3 个工作空间各 1000 篇、都已打开时，空闲 RSS 应 ≤ 80MB（暂定，实测后再调）。只有默认工作空间时，RSS 不能比现在高出 2MB 以上。
- 监听句柄：Linux 的 inotify watch 数按目录数累加，外部大库可能触到 `max_user_watches` 上限，这时记一条警告日志并提示调整方法。

## 12. 验收

能自动判定的都写成测试：

- Go：升级旧 `app.db` 后结构正确；新建工作空间的 `index.db` 结构和默认空间一致；同名同路径的笔记在两个空间互不影响；`/api/...` 和 `/api/w/default/...` 返回相同结果；未知 id 返回 404；绑定 A 空间的 MCP token 读不到 B 空间；删除外部工作空间后外部文件完好；外部路径嵌套或相同时拒绝创建；backup/restore 往返（包括旧版备份）。
- 前端单测：API 前缀拼接；按工作空间区分 localStorage 键和 IndexedDB 名称。
- Playwright（新 spec，排在 smoke 之后）：新建工作空间 → 写笔记 → 切回默认空间看不到 → 再切回来笔记还在；在 A 空间离线编辑后切到 B 空间，再切回 A 恢复网络，写队列能补发；两个标签页分别打开两个空间，各自实时同步。
- 3 级（截图推送）：侧栏的工作空间切换器、设置页的工作空间分区，在三种宽度下各截一张。
- 4 级（人工）：手机 PWA 上切换工作空间；把一个已有的 Obsidian 库作为外部工作空间接入。

## 13. 实施拆分

| # | 任务 | 抽象程度 | 努力程度 |
|---|---|---|---|
| 1 | 迁移 0006：新增 `workspaces` 表和 `api_tokens.workspace_id`、`audit_log.workspace_id`；写升级测试和同构测试 | 低 | 低 |
| 2 | `internal/workspace` Manager：登记、按需打开、关停、路径校验、加锁 | 中 | 高 |
| 3 | `agent.Store` 拆分出 `ChatStore`，`agent.Service` 改成按工作空间取依赖 | 中 | 中 |
| 4 | API 中间件和双前缀路由挂载，处理函数改为从 context 取工作空间 | 低 | 中 |
| 5 | `/api/workspaces` 的增删改查和删除流程 | 低 | 中 |
| 6 | MCP token 绑定工作空间、审计日志加列和筛选 | 低 | 低 |
| 7 | backup/restore 支持多工作空间和外部目录，兼容旧备份 | 中 | 高 |
| 8 | `lode workspace` 子命令 | 低 | 低 |
| 9 | 前端：API 前缀、路由、同步引擎和 LocalDB 按工作空间实例化 | 中 | 高 |
| 10 | 前端：localStorage 键按工作空间区分 | 低 | 低 |
| 11 | 前端：侧栏切换器、命令面板、设置页分区 | 中 | 中 |
| 12 | 前端：MCP token 创建时选择工作空间，助手对话按工作空间过滤 | 低 | 低 |
| 13 | Playwright 用例、截图、内存测量 | 低 | 中 |
| 14 | 文档：SPEC、api.md、mcp.md、deploy.md、AGENTS.md 常用命令 | 低 | 低 |

依赖关系：1 → 2 → {3, 4} → {5, 6, 7, 8}；9 依赖 4；{10, 11, 12} 依赖 9；13 和 14 放在最后。

## 14. 已确认的决定（2026-11-08）

1. 第一版就支持外部目录。
2. 删除内置工作空间时，目录移到 `data/trash-workspaces/`，不直接删除。
3. 作为阶段 7 推进，分支名 `stage-7-workspaces`，任务说明另存为 `docs/stages/stage-7.md`。

## 15. 处理结果

- 阶段 7 的 issue 号是 #54（#7 已被占用），已在 `AGENTS.md` 开头说明。
- SPEC 已补“工作空间”一节并在阶段表里加上阶段 7（#64）。

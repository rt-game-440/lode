# 阶段 4/6：API token 与 MCP 服务

依赖：阶段 1（#1）。可以和阶段 2、3 并行；若阶段 2 已合并，MCP 写入要接入它的合并逻辑和变更事件。开始前按 `AGENTS.md` 的"开始一个阶段"执行，共同约定见 `docs/SPEC.md`。分支名 `stage-4-mcp`。

目标：其他 agent（Claude Code、Codex、Cursor 等）能通过 MCP 搜索、阅读和编辑笔记。

## 开始顺序

1. 查官方 Go SDK `github.com/modelcontextprotocol/go-sdk` 的最新版本、Streamable HTTP 服务端用法和支持的协议版本，结论记进 MEMORY.md。SDK 不能满足需求时停下来问，不要自己手写协议。
2. 再开始实现。

## 范围内

### API token

- 设置页增加"API token"：创建时填名称、选权限（只读 / 读写）；明文只在创建后显示一次，可复制；列表显示名称、权限、创建时间、最后使用时间；可吊销。
- 后端只存 token 的 SHA-256 哈希（token 为 32 字节以上随机值，高熵，不需要慢哈希）。

### 工具注册表

在 `server/internal/tools` 建工具注册表：每个工具有名称、给模型看的描述、输入 JSON Schema、是否只读、处理函数。处理函数只调用 `server/internal/notes`。阶段 5 的 Agent 复用同一份注册表，所以描述要写给大模型看：说明用途、参数含义、返回内容和常见错误。

工具清单：

| 工具 | 参数 | 说明 |
|---|---|---|
| `search_notes` | query, limit（默认 20）, path_prefix? | 返回 path、标题、片段、修改时间 |
| `read_note` | path, start_line?, max_lines?（默认 2000） | 返回正文和 rev；长文分段读取 |
| `list_notes` | path_prefix?, recursive? | 文件夹树 |
| `create_note` | path, content | 路径已存在时报错 |
| `update_note` | path, base_rev, mode: replace / append / patch, content 或 edits: [{old, new}] | patch 中 old 必须唯一匹配；base_rev 过期时走阶段 2 的合并（阶段 2 未合并时返回冲突错误） |
| `move_note` | from, to | 同时更新引用 |
| `delete_note` | path | 进回收站 |
| `get_backlinks` | path | |
| `list_tags` / `get_notes_by_tag` | tag | |

### MCP 服务

- `/mcp` 用 Streamable HTTP，Bearer token 鉴权；无效或已吊销的 token 返回 401；只读 token 看不到也调用不了写工具。
- MCP 写入和界面写入一样产生 seq 变更事件，打开的客户端能看到；设备名显示为 token 名称。
- 审计日志：每次调用记录时间、token 名称、工具、路径、成功或错误，存在 SQLite，保留约最近 1000 条；设置页可以查看。
- `docs/mcp.md`：Claude Code、Codex、Cursor 的接入示例。示例命令必须实测过；无法实测的客户端标明"未实测"。

## 范围外

MCP 的 OAuth 授权（本阶段只用静态 Bearer token）、stdio 桥接子命令（可选扩展）、MCP resources 和 prompts（可选扩展）、Agent 界面。

## 保持不变

已有 REST API 和会话鉴权不变；已有测试继续通过。

## 验收标准

1. Go 测试：用 SDK 客户端连接 httptest 起的服务，列出工具并调用每个工具，覆盖成功和错误情况：路径不存在、目录穿越、只读 token 调写工具被拒、base_rev 过期、patch 的 old 匹配到多处。
2. 无 token、错误 token、已吊销 token 都返回 401。
3. 用 Claude Code 或 MCP Inspector 实际接入本地服务：搜索 → 读取 → 追加一行；浏览器里的应用能看到这次修改（阶段 2 已合并时无需刷新，未合并时刷新后看到；截图作证据）。
4. 设置页能创建、复制、吊销 token，审计日志显示上一步的调用（Playwright）。
5. `docs/mcp.md` 中的命令都已实测，或标明"未实测"。

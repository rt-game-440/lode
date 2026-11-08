# 用 MCP 接入 Lode

Lode 在 `/mcp` 提供 MCP 服务（Streamable HTTP），Claude Code、Codex、Cursor 等 agent 可以通过它搜索、阅读和编辑笔记。

标注说明：**已实测**的命令都在本机跑过，证据在 `docs/evidence/stage-4/`；**未实测**的写法来自客户端官方文档，本机没有装这个客户端。

## 1. 准备

1. 打开 Lode 的“设置”页，在“API token”里填名称（建议每个 agent 一个，例如 `Claude Code`），选择权限：
   - **只读**：只能用搜索、阅读、列出类工具，写工具对它不可见；
   - **读写**：还可以新建、修改、移动和删除笔记（删除进回收站）。
2. 选择 token 能访问的**工作空间**（默认是当前所在的工作空间）。一个 token 只绑定一个工作空间，搜索、阅读、编辑都只在这个工作空间里进行，看不到其他工作空间的笔记；要让同一个 agent 访问多个工作空间，为每个工作空间各建一个 token。
3. 点“创建 token”，立即复制明文 token。它只显示这一次，服务器只保存哈希。
4. MCP 地址在设置页顶部，形如 `https://notes.example.com/mcp`。本地开发时是 `http://127.0.0.1:8787/mcp`。

下文用 `$LODE_URL` 表示 MCP 地址，`$LODE_TOKEN` 表示 token。推荐把 token 放进环境变量，不要直接写进会提交到仓库的配置文件。

## 2. Claude Code

### 命令行添加（已实测）

```bash
claude mcp add --transport http lode "$LODE_URL" --header "Authorization: Bearer $LODE_TOKEN"
```

```bash
claude mcp list
```

`claude mcp list` 应显示 `lode: … (HTTP) - ✔ Connected`。设置页创建 token 后，也会直接给出这条命令（已填好地址和 token），复制即可。

默认写入当前项目的本地配置（`--scope local`）；想在所有项目里使用，加 `--scope user`。

证据：`docs/evidence/stage-4/live-claude-mcp-add.txt`。

### 项目配置文件（已实测）

在项目根目录的 `.mcp.json` 里写下面的内容，token 从环境变量展开，配置文件本身可以提交：

```json
{
  "mcpServers": {
    "lode": {
      "type": "http",
      "url": "https://notes.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LODE_TOKEN}" }
    }
  }
}
```

实测时用 `claude -p --mcp-config <这个文件> --strict-mcp-config` 加载同样的内容，让 Claude Code（haiku）依次调用 `search_notes` → `read_note` → `update_note`（append）。浏览器里打开着的那篇笔记，没有刷新就出现了追加的一行。

证据：`docs/evidence/stage-4/live-claude-code.txt`、截图 `docs/screenshots/stage-4/4-4-before-mcp.png` 和 `4-4-after-claude-code.png`。脚本：`node web/scripts/mcp-live-check.mjs`。

## 3. Codex CLI（未实测）

写法来自 OpenAI 的 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。在 `~/.codex/config.toml`（或受信任项目的 `.codex/config.toml`）里加：

```toml
[mcp_servers.lode]
url = "https://notes.example.com/mcp"
bearer_token_env_var = "LODE_TOKEN"
```

或者用命令添加：

```bash
codex mcp add lode --url https://notes.example.com/mcp --bearer-token-env-var LODE_TOKEN
```

启动 Codex 的 shell 里必须已经设置了 `LODE_TOKEN`，否则请求会返回 401。

## 4. Cursor（未实测）

写法来自 [Cursor MCP 文档](https://cursor.com/docs/context/mcp)。在 `~/.cursor/mcp.json`（全局）或项目的 `.cursor/mcp.json` 里加：

```json
{
  "mcpServers": {
    "lode": {
      "url": "https://notes.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:LODE_TOKEN}" }
    }
  }
}
```

注意 Cursor 的环境变量写法是 `${env:NAME}`，和 Claude Code 的 `${NAME}` 不同。Cursor 论坛上有人报告过旧版本不展开远程服务器 headers 里的变量，官方回复说已经修复。如果连接返回 401，可以先把 token 直接写进 `headers` 排查。

## 5. 直接用 curl 调试（已实测）

服务是无状态的，不需要先 `initialize`，可以直接发 JSON-RPC 请求。`Accept` 头必须同时包含 `application/json` 和 `text/event-stream`。

列出工具：

```bash
curl -s "$LODE_URL" -H "Authorization: Bearer $LODE_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

调用工具：

```bash
curl -s "$LODE_URL" -H "Authorization: Bearer $LODE_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"MCP"}}}'
```

不带 token 时返回 401：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$LODE_URL" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
```

在 Windows 的 Git Bash 里，`-d` 参数中的中文可能被转成本地代码页后再发出，服务器收到的是乱码。请求体含中文时，改用 `--data-binary @文件名` 或 `--data-binary @-` 从标准输入读取。

证据：`docs/evidence/stage-4/curl.txt`。脚本：`bash web/scripts/mcp-curl-check.sh`。

## 6. 工具

| 工具 | 只读 token 可用 | 参数 | 返回 |
| --- | --- | --- | --- |
| `search_notes` | ✓ | `query`，`limit`（默认 20，最大 100），`path_prefix` | 每条含 path、title、snippet（命中处用 `**` 包裹）、modified |
| `read_note` | ✓ | `path`，`start_line`（默认 1），`max_lines`（默认 2000） | 正文片段、`rev`、`total_lines`、`truncated`；长文分段读取 |
| `list_notes` | ✓ | `path_prefix`，`recursive` | 子文件夹和笔记 |
| `get_backlinks` | ✓ | `path` | 引用这篇笔记的笔记，以及引用所在的行 |
| `list_tags` | ✓ | 无 | 标签及笔记数 |
| `get_notes_by_tag` | ✓ | `tag`（可带 `#`，包含子标签） | 笔记列表 |
| `create_note` | | `path`，`content` | 路径已存在时报错 |
| `update_note` | | `path`，`base_rev`，`mode`（`replace` / `append` / `patch`），`content` 或 `edits: [{old, new}]` | 新的 `rev`；自动合并时 `merged: true` |
| `move_note` | | `from`，`to` | 同时更新其他笔记里的链接，返回被改写的笔记列表 `updated_links` |
| `delete_note` | | `path` | 进回收站，可在网页端恢复 |

修改规则：

- 修改前先用 `read_note` 拿到 `rev`，作为 `update_note` 的 `base_rev`。
- `base_rev` 过期时，服务器做三方合并：
  - 改动不重叠：自动合并；
  - 改动重叠：服务器版本不变，这次的内容另存为冲突副本，返回错误并说明副本路径。
- `append` 总是追加到最新版本末尾，不会冲突。
- `patch` 中每个 `old` 必须在全文里恰好出现一次，否则整次修改都不生效，错误里会说明是第几处、匹配了几次。

所有错误都以工具结果（`isError: true`）返回中文说明，方便模型自行纠正。只读 token 调用写工具时，返回协议错误 “unknown tool”。

## 7. 安全

- **使用 HTTPS**：token 放在请求头里，经公网访问时必须走 HTTPS（反向代理配置见 `docs/dev-https.md`）。
- **最小权限**：只需要查资料的 agent 用只读 token。
- **按工作空间隔离**：token 创建时绑定一个工作空间，之后不能更改。绑定的工作空间被删除时，这个 token 一并作废，请求返回 401；升级前创建的旧 token 属于默认工作空间，照常使用。
- **分别创建、单独吊销**：每个 agent 一个 token，调用记录里能区分来源；不再使用或怀疑泄露时，在设置页吊销，吊销后立即返回 401。
- **调用记录**：设置页的“调用记录”保留最近 1000 次工具调用，包括时间、token 名称、工作空间、工具、路径和结果。
- **变更来源**：MCP 写入和网页端写入一样，会实时推送到打开的客户端，变更事件里的设备名就是 token 名称。
- **不支持 OAuth**：`/mcp` 只接受静态 Bearer token。REST API（`/api/*`）仍然只认会话 cookie，不接受 token。

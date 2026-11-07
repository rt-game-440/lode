# Lode HTTP API

阶段 1 的 REST 接口。所有请求和响应体都是 UTF-8 JSON（附件上传和文件下载除外），时间字段都是 unix 毫秒。

## 约定

- **鉴权**：除 `/api/health` 和 `/api/auth/*` 外都需要会话 cookie `lode_session`（HttpOnly、SameSite=Lax；直连 HTTPS，或可信代理转发 `X-Forwarded-Proto: https` 时带 Secure）。未登录返回 `401 unauthorized`。
- **反向代理**：只有直连方在 `LODE_TRUSTED_PROXIES`（默认 `127.0.0.0/8,::1`）里时，才采用 `X-Forwarded-For` 和 `X-Forwarded-Proto`。
- **设备标识**（可选）：请求头 `X-Device-Id`（≤64 字符）和 `X-Device-Name`（URL 编码，≤64 字符），写入变更事件的 `device_id` / `device_name`。
- **符号链接**：vault 内不跟随符号链接和目录联接，经过它们的路径返回 `invalid_path`。
- **路径**：相对 vault 根目录，用 `/` 分隔，笔记以 `.md` 结尾。`..`、绝对路径或盘符、以 `.` 开头的段、控制字符和 `<>"|?*`、以空格结尾的名称都会被拒绝（`invalid_path`）。
- **乐观并发**：修改正文必须带 `base_rev`，与服务器当前 `rev` 不一致时返回 `409 conflict` 和 `current_rev`。
- **请求体上限**：JSON 32 MB；附件 20 MB。

### 错误格式

```json
{ "code": "conflict", "message": "版本冲突：当前 rev 为 7", "current_rev": 7 }
```

| HTTP | code | 说明 | 附加字段 |
| --- | --- | --- | --- |
| 400 | `bad_request` | JSON 无法解析、缺少必填字段、参数非法 | |
| 400 | `invalid_path` | 路径不合法或越出 vault | |
| 400 | `weak_password` | 设置的密码少于 8 个字符 | |
| 401 | `unauthorized` | 未登录或会话过期 | |
| 401 | `wrong_password` | 密码错误 | |
| 404 | `not_found` | 笔记、文件夹、回收站条目或文件不存在 | |
| 409 | `conflict` | `base_rev` 过期 | `current_rev` |
| 409 | `exists` | 目标路径已被占用 | |
| 409 | `already_initialized` | 密码已经设置过 | |
| 409 | `not_initialized` | 还没设置密码就尝试登录 | |
| 422 | `patch_failed` | patch 的某处 `old` 没有唯一匹配 | `index`（从 0 开始）、`matches` |
| 429 | `rate_limited` | 同一 IP 连续 5 次密码错误后锁定 | `retry_after`（秒），并带 `Retry-After` 头 |
| 500 | `internal` | 服务器内部错误（详情只写服务器日志） | |

### 数据类型

```ts
// 笔记元数据
type Note = {
  id: string          // 稳定 id，重命名/移动/外部改名都不变
  path: string        // 例如 "项目/Lode.md"
  title: string       // 文件名去掉 .md
  rev: number         // 每次写入 +1
  hash: string        // 正文 sha256
  size: number
  mtime: number
  created_at: number
  updated_at: number
}
type NoteContent = Note & { content: string }
type TrashItem = { id: string; path: string; title: string; deleted_at: number }
type Change = {
  seq: number
  type: 'upsert' | 'move' | 'delete'
  id: string
  path: string        // move 时为新路径
  rev: number
  device_id: string
  device_name: string
  created_at: number
}
```

## 健康检查与鉴权

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | | `200 {"status":"ok","version":"…"}` |
| GET | `/api/auth/status` | | `200 {"initialized":bool,"authenticated":bool}` |
| POST | `/api/auth/setup` | `{"password":"…"}` | `204` 并写入会话 cookie；`400 weak_password`；`409 already_initialized` |
| POST | `/api/auth/login` | `{"password":"…"}` | `204` 并写入会话 cookie；`401 wrong_password`；`409 not_initialized`；`429 rate_limited` |
| POST | `/api/auth/logout` | | `204`，删除会话并清除 cookie |

密码用 argon2id 哈希；会话 30 天有效，每次使用顺延。限流按客户端 IP 计数（1 分钟内 5 次错误锁定 60 秒），锁定期间即使密码正确也返回 429。

## 笔记

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/tree` | | `200 {"folders":string[],"notes":Note[],"seq":number}`；`seq` 是生成时的最新变更序号，可作为 `/api/changes?since=` 的起点 |
| GET | `/api/notes?prefix=&recursive=` | `prefix` 文件夹路径；`recursive=false` 只列直接子项 | `200 {"notes":Note[]}` |
| POST | `/api/notes` | `{"path":"a/b.md","content":"…","auto_rename":false}` | `201 NoteContent`；`auto_rename=true` 时路径被占用会自动加序号（如 `b 1.md`）；否则 `409 exists` |
| GET | `/api/notes/{id}` | | `200 NoteContent` |
| GET | `/api/notes/by-path?path=` | | `200 NoteContent` |
| PUT | `/api/notes/{id}` | `{"base_rev":3,"content":"…"}` | `200 NoteContent`；`409 conflict` |
| PATCH | `/api/notes/{id}` | `{"base_rev":3,"edits":[{"old":"…","new":"…"}]}` | `200 NoteContent`；`422 patch_failed`；`409 conflict` |
| DELETE | `/api/notes/{id}` | | `200 TrashItem`（移到回收站） |
| POST | `/api/notes/{id}/move` | `{"path":"新/路径.md"}` | `200 {"note":Note,"updated":Note[]}`；`updated` 是因改写 `[[链接]]` 而被修改的其他笔记 |
| GET | `/api/notes/{id}/backlinks` | | `200 {"backlinks":[{"id","path","title","lines":[{"line":number,"text":string}]}]}` |
| GET | `/api/notes/{id}/tags` | | `200 {"tags":string[]}` |

PATCH 的 `edits` 按顺序应用，每处 `old` 必须在当时的正文里恰好出现一次，任一处失败则整体不写入。

## 搜索与标签

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/search?q=&limit=&path_prefix=` | `q` 空格分隔多个词（AND）；`limit` 默认 20，最大 200 | `200 {"results":[{"id","path","title","snippet","mtime"}]}` |
| GET | `/api/tags` | | `200 {"tags":[{"tag":string,"count":number}]}` |
| GET | `/api/tags/notes?tag=` | 包含子标签（`项目` 会匹配 `项目/lode`） | `200 {"notes":Note[]}` |

搜索用 SQLite FTS5 trigram 分词，3 个字符以下的词退回 LIKE 匹配，按 bm25 排序（标题权重 10）。`snippet` 中命中部分用 `\u0002` 和 `\u0003` 包裹，客户端自行转成高亮。

标签来自 frontmatter 的 `tags` 和正文中的 `#标签`（前面必须是行首、空白或标点；不能是纯数字；代码块和行内代码里的不算），统一转成小写。

## 文件夹

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/folders` | `{"path":"a/b"}` | `201 {"path":"a/b"}` |
| POST | `/api/folders/move` | `{"from":"a","to":"c/a"}` | `200 {"path":string,"moved":number,"updated":Note[]}` |
| DELETE | `/api/folders?path=` | | `200 {"trashed":number}`；其中笔记逐篇进回收站，其他文件移到 `DATA_DIR/trash/folders` |

## 回收站

回收站文件保存在 `DATA_DIR/trash`，不在 vault 里。

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/trash` | `200 {"items":TrashItem[]}` |
| POST | `/api/trash/{id}/restore` | `200 Note`；保留原 id，原路径被占用时自动改名 |
| DELETE | `/api/trash/{id}` | `204`，彻底删除 |
| DELETE | `/api/trash` | `204`，清空回收站 |

## 附件与文件

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/attachments` | `multipart/form-data`，字段 `file` | `201 {"path":"attachments/x.png","url":"/api/files/attachments/x.png"}` |
| GET | `/api/files/{path...}` | | 文件内容，支持 Range；带沙箱 CSP，防止上传的 SVG/HTML 执行脚本 |

粘贴的图片没有有意义的文件名时命名为 `pasted-YYYYMMDD-HHMMSS.<ext>`；同名文件自动加序号。

## 变更流

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/changes?since=&limit=` | `since` 上次拿到的 `seq`；`limit` 默认且最大 1000 | `200 {"changes":Change[],"seq":number}` |

所有写入（API、外部编辑器、文件监听对账）都会产生变更事件。阶段 1 的前端每秒轮询一次；阶段 2 改为 WebSocket 推送，此接口保留用于断线补齐。

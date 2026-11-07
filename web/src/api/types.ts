// 与 docs/api.md 对应的类型。

export interface Note {
  id: string
  path: string
  title: string
  rev: number
  hash: string
  size: number
  mtime: number
  created_at: number
  updated_at: number
}

export interface NoteContent extends Note {
  content: string
  /** 写入基于旧版本、服务器做了三方合并时为 true，content 是合并后的全文 */
  merged?: boolean
}

export interface Tree {
  folders: string[]
  notes: Note[]
  seq: number
}

export interface SearchResult {
  id: string
  path: string
  title: string
  /** 命中部分用 \u0002 和 \u0003 包裹 */
  snippet: string
  mtime: number
}

export interface BacklinkLine {
  line: number
  text: string
}

export interface Backlink {
  id: string
  path: string
  title: string
  lines: BacklinkLine[]
}

export interface TagCount {
  tag: string
  count: number
}

export interface TrashItem {
  id: string
  path: string
  title: string
  deleted_at: number
}

export interface Change {
  seq: number
  type: 'upsert' | 'move' | 'delete'
  id: string
  path: string
  rev: number
  device_id: string
  device_name: string
  created_at: number
}

export interface MoveResult {
  note: Note
  updated: Note[]
}

export interface AuthStatus {
  initialized: boolean
  authenticated: boolean
}

export type TokenScope = 'read' | 'write'

/** API token 的元数据（不含明文）。 */
export interface ApiToken {
  id: string
  name: string
  scope: TokenScope
  created_at: number
  /** 0 表示从未使用 */
  last_used_at: number
}

/** 一条 MCP 调用记录。 */
export interface AuditEntry {
  id: number
  at: number
  token_id: string
  token_name: string
  tool: string
  target: string
  ok: boolean
  error?: string
  duration_ms: number
}

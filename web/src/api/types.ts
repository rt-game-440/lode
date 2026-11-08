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
  /** 当前访问的域名下是否登记了通行密钥（登录页据此显示通行密钥按钮） */
  passkey?: boolean
}

/** 登记的通行密钥（不含密钥材料）。last_used_at 为 0 表示从未使用。 */
export interface Passkey {
  id: string
  name: string
  created_at: number
  last_used_at: number
  /** 是否支持 PRF 扩展（能否用来保护 API key）：登记或验证时探测到的结果，null 表示还不知道 */
  prf?: boolean | null
  /** 是否加入了 API key 保护（能用它解锁） */
  key_wrapped?: boolean
}

/** “用通行密钥保护 API key”的状态（#29）。 */
export interface KeyProtection {
  /** false：服务器设置了 LODE_SECRET_KEY，不能用通行密钥保护 */
  available: boolean
  reason?: 'env'
  enabled: boolean
  /** 开启后服务重启即锁定，用加入保护的通行密钥登录或验证一次后解锁 */
  unlocked: boolean
  /** 加入保护的通行密钥个数 */
  wrapped: number
}

export type KeyProtectionAction = 'enable' | 'unlock' | 'enroll'

/** begin 接口的响应：仪式 ID 加浏览器 WebAuthn API 的选项（JSON 形式）。 */
export interface PasskeyCeremony {
  ceremony: string
  options: { publicKey: Record<string, any> }
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

/** 工作空间（docs/api.md 的“工作空间”一节）。id 创建后不变，`default` 是默认工作空间。 */
export interface WorkspaceInfo {
  id: string
  name: string
  external: boolean
  /** 只对外部目录返回 */
  vault_dir?: string
  sort: number
  created_at: number
  /** 索引里的笔记数；还没打开过的工作空间读的是上次的索引 */
  note_count: number
}

import { deviceId, deviceName } from '../lib/device'
import type {
  ApiToken,
  AuditEntry,
  AuthStatus,
  Backlink,
  Change,
  MoveResult,
  Note,
  NoteContent,
  SearchResult,
  TagCount,
  TokenScope,
  TrashItem,
  Tree,
} from './types'

/** 接口返回的错误：status 为 HTTP 状态码，code 为 docs/api.md 中的错误码。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** 把错误转成给用户看的中文提示。 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'exists':
        return '同名的笔记或文件夹已存在'
      case 'invalid_path':
        return '名称不合法'
      case 'not_found':
        return '笔记不存在，可能已被删除'
      case 'conflict':
        return '笔记已在别处被修改'
      case 'network':
        return '网络不可用'
    }
    return err.message || '操作失败'
  }
  return err instanceof Error ? err.message : String(err)
}

/** 未登录（会话失效）时的回调，由会话 store 注册。 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'X-Device-Id': deviceId(),
    'X-Device-Name': encodeURIComponent(deviceName()),
  }
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'network', '网络不可用')
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as Record<string, unknown>
    if (res.status === 401 && d.code === 'unauthorized') onUnauthorized?.()
    throw new ApiError(res.status, String(d.code ?? 'error'), String(d.message ?? res.statusText), d)
  }
  return data as T
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  health: () => request<{ status: string; version: string }>('GET', '/api/health'),

  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (password: string) => request<void>('POST', '/api/auth/setup', { password }),
  login: (password: string) => request<void>('POST', '/api/auth/login', { password }),
  logout: () => request<void>('POST', '/api/auth/logout'),

  tree: () => request<Tree>('GET', '/api/tree'),
  readNote: (id: string) => request<NoteContent>('GET', `/api/notes/${encodeURIComponent(id)}`),
  createNote: (path: string, content = '', autoRename = false) =>
    request<NoteContent>('POST', '/api/notes', { path, content, auto_rename: autoRename }),
  updateNote: (id: string, baseRev: number, content: string, init?: RequestInit) =>
    request<NoteContent>('PUT', `/api/notes/${encodeURIComponent(id)}`, { base_rev: baseRev, content }, init),
  moveNote: (id: string, path: string) => request<MoveResult>('POST', `/api/notes/${encodeURIComponent(id)}/move`, { path }),
  deleteNote: (id: string) => request<TrashItem>('DELETE', `/api/notes/${encodeURIComponent(id)}`),
  backlinks: (id: string) =>
    request<{ backlinks: Backlink[] }>('GET', `/api/notes/${encodeURIComponent(id)}/backlinks`).then((r) => r.backlinks),
  noteTags: (id: string) =>
    request<{ tags: string[] }>('GET', `/api/notes/${encodeURIComponent(id)}/tags`).then((r) => r.tags ?? []),

  search: (query: string, limit = 30) =>
    request<{ results: SearchResult[] }>('GET', `/api/search${q({ q: query, limit })}`).then((r) => r.results),
  tags: () => request<{ tags: TagCount[] }>('GET', '/api/tags').then((r) => r.tags),
  notesByTag: (tag: string) => request<{ notes: Note[] }>('GET', `/api/tags/notes${q({ tag })}`).then((r) => r.notes),

  createFolder: (path: string) => request<{ path: string }>('POST', '/api/folders', { path }),
  moveFolder: (from: string, to: string) =>
    request<{ path: string; moved: number; updated: Note[] }>('POST', '/api/folders/move', { from, to }),
  deleteFolder: (path: string) => request<{ trashed: number }>('DELETE', `/api/folders${q({ path })}`),

  trash: () => request<{ items: TrashItem[] }>('GET', '/api/trash').then((r) => r.items),
  restore: (id: string) => request<Note>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),
  purge: (id: string) => request<void>('DELETE', `/api/trash/${encodeURIComponent(id)}`),
  emptyTrash: () => request<void>('DELETE', '/api/trash'),

  uploadAttachment: (file: File | Blob, name?: string) => {
    const fd = new FormData()
    fd.append('file', file, name ?? (file instanceof File ? file.name : 'image.png'))
    return request<{ path: string; url: string }>('POST', '/api/attachments', fd)
  },

  changes: (since: number) => request<{ changes: Change[]; seq: number }>('GET', `/api/changes${q({ since })}`),

  tokens: () => request<{ tokens: ApiToken[] }>('GET', '/api/tokens').then((r) => r.tokens),
  createToken: (name: string, scope: TokenScope) =>
    request<{ token: ApiToken; secret: string }>('POST', '/api/tokens', { name, scope }),
  revokeToken: (id: string) => request<void>('DELETE', `/api/tokens/${encodeURIComponent(id)}`),
  audit: (limit = 100) => request<{ entries: AuditEntry[] }>('GET', `/api/audit${q({ limit })}`).then((r) => r.entries),
}

/** vault 内文件的访问 URL。 */
export function fileUrl(path: string): string {
  return '/api/files/' + path.split('/').map(encodeURIComponent).join('/')
}

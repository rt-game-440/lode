import { deviceId, deviceName } from '../lib/device'
import { apiPrefix, currentWorkspace, workspaceOfApiUrl } from '../lib/workspace'
import type {
  ApiToken,
  AuditEntry,
  AuthStatus,
  Backlink,
  Change,
  KeyProtection,
  KeyProtectionAction,
  MoveResult,
  Note,
  NoteContent,
  Passkey,
  PasskeyCeremony,
  SearchResult,
  TagCount,
  TokenScope,
  TrashItem,
  Tree,
  WorkspaceInfo,
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
      case 'workspace_not_found':
        return '工作空间不存在'
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

/** 请求的工作空间不存在（被删除或地址写错）时的回调，参数是工作空间 id；由工作空间 store 注册。 */
let onWorkspaceMissing: ((ws: string) => void) | null = null
export function setWorkspaceMissingHandler(fn: (ws: string) => void) {
  onWorkspaceMissing = fn
}

export async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
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
    if (res.status === 404 && d.code === 'workspace_not_found') {
      const ws = workspaceOfApiUrl(url)
      if (ws) onWorkspaceMissing?.(ws)
    }
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

/**
 * 全局接口（鉴权、通行密钥、token、审计、工作空间登记等），不挂工作空间前缀。
 */
const globalApi = {
  health: () => request<{ status: string; version: string }>('GET', '/api/health'),

  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (password: string) => request<void>('POST', '/api/auth/setup', { password }),
  login: (password: string) => request<void>('POST', '/api/auth/login', { password }),
  logout: () => request<void>('POST', '/api/auth/logout'),

  passkeyLoginBegin: () => request<PasskeyCeremony>('POST', '/api/auth/passkey/begin'),
  passkeyLoginFinish: (ceremony: string, credential: unknown) =>
    request<void>('POST', `/api/auth/passkey/finish${q({ ceremony })}`, credential),
  passkeys: () => request<{ passkeys: Passkey[] }>('GET', '/api/passkeys').then((r) => r.passkeys),
  passkeyRegisterBegin: (name: string) => request<PasskeyCeremony>('POST', '/api/passkeys/begin', { name }),
  passkeyRegisterFinish: (ceremony: string, credential: unknown) =>
    request<{ passkey: Passkey }>('POST', `/api/passkeys/finish${q({ ceremony })}`, credential).then((r) => r.passkey),
  /** force：删除最后一个能解锁 API key 的通行密钥时确认（会关闭保护），否则服务端返回 409 last_key_passkey。 */
  deletePasskey: (id: string, force = false) =>
    request<void>('DELETE', `/api/passkeys/${encodeURIComponent(id)}${q({ force: force ? 1 : undefined })}`),
  keyProtection: () => request<{ key_protection: KeyProtection }>('GET', '/api/key-protection').then((r) => r.key_protection),
  keyProtectionBegin: (action: KeyProtectionAction, passkey?: string) =>
    request<PasskeyCeremony>('POST', '/api/key-protection/begin', { action, passkey }),
  keyProtectionFinish: (ceremony: string, credential: unknown) =>
    request<{ key_protection: KeyProtection }>('POST', `/api/key-protection/finish${q({ ceremony })}`, credential).then((r) => r.key_protection),
  keyProtectionLock: () => request<{ key_protection: KeyProtection }>('POST', '/api/key-protection/lock').then((r) => r.key_protection),
  /** discard：锁定时放弃已保存的 API key 并关闭（找不回主密钥时用）。 */
  keyProtectionDisable: (discard = false) =>
    request<{ key_protection: KeyProtection; cleared_keys: number }>('POST', '/api/key-protection/disable', { discard }),

  workspaces: () => request<{ workspaces: WorkspaceInfo[] }>('GET', '/api/workspaces').then((r) => r.workspaces),
  createWorkspace: (name: string) => request<WorkspaceInfo>('POST', '/api/workspaces', { name }),

  tokens: () => request<{ tokens: ApiToken[] }>('GET', '/api/tokens').then((r) => r.tokens),
  createToken: (name: string, scope: TokenScope) =>
    request<{ token: ApiToken; secret: string }>('POST', '/api/tokens', { name, scope }),
  revokeToken: (id: string) => request<void>('DELETE', `/api/tokens/${encodeURIComponent(id)}`),
  audit: (limit = 100) => request<{ entries: AuditEntry[] }>('GET', `/api/audit${q({ limit })}`).then((r) => r.entries),
}

/**
 * 按工作空间区分的接口（笔记、树、文件夹、搜索、标签、附件、回收站、增量变更）。
 * prefix() 在每次调用时求值：`/api` 或 `/api/w/<id>`。
 */
function notesApi(prefix: () => string) {
  const enc = encodeURIComponent
  return {
    tree: () => request<Tree>('GET', `${prefix()}/tree`),
    readNote: (id: string) => request<NoteContent>('GET', `${prefix()}/notes/${enc(id)}`),
    createNote: (path: string, content = '', autoRename = false) =>
      request<NoteContent>('POST', `${prefix()}/notes`, { path, content, auto_rename: autoRename }),
    updateNote: (id: string, baseRev: number, content: string, init?: RequestInit) =>
      request<NoteContent>('PUT', `${prefix()}/notes/${enc(id)}`, { base_rev: baseRev, content }, init),
    moveNote: (id: string, path: string) => request<MoveResult>('POST', `${prefix()}/notes/${enc(id)}/move`, { path }),
    deleteNote: (id: string) => request<TrashItem>('DELETE', `${prefix()}/notes/${enc(id)}`),
    backlinks: (id: string) =>
      request<{ backlinks: Backlink[] }>('GET', `${prefix()}/notes/${enc(id)}/backlinks`).then((r) => r.backlinks),
    noteTags: (id: string) =>
      request<{ tags: string[] }>('GET', `${prefix()}/notes/${enc(id)}/tags`).then((r) => r.tags ?? []),

    search: (query: string, limit = 30) =>
      request<{ results: SearchResult[] }>('GET', `${prefix()}/search${q({ q: query, limit })}`).then((r) => r.results),
    tags: () => request<{ tags: TagCount[] }>('GET', `${prefix()}/tags`).then((r) => r.tags),
    notesByTag: (tag: string) => request<{ notes: Note[] }>('GET', `${prefix()}/tags/notes${q({ tag })}`).then((r) => r.notes),

    createFolder: (path: string) => request<{ path: string }>('POST', `${prefix()}/folders`, { path }),
    moveFolder: (from: string, to: string) =>
      request<{ path: string; moved: number; updated: Note[] }>('POST', `${prefix()}/folders/move`, { from, to }),
    deleteFolder: (path: string) => request<{ trashed: number }>('DELETE', `${prefix()}/folders${q({ path })}`),

    trash: () => request<{ items: TrashItem[] }>('GET', `${prefix()}/trash`).then((r) => r.items),
    restore: (id: string) => request<Note>('POST', `${prefix()}/trash/${enc(id)}/restore`),
    purge: (id: string) => request<void>('DELETE', `${prefix()}/trash/${enc(id)}`),
    emptyTrash: () => request<void>('DELETE', `${prefix()}/trash`),

    uploadAttachment: (file: File | Blob, name?: string) => {
      const fd = new FormData()
      fd.append('file', file, name ?? (file instanceof File ? file.name : 'image.png'))
      return request<{ path: string; url: string }>('POST', `${prefix()}/attachments`, fd)
    },

    images: () =>
      request<{ images: { path: string; size: number; mtime: number }[] }>('GET', `${prefix()}/images`).then((r) => r.images),

    changes: (since: number) => request<{ changes: Change[]; seq: number }>('GET', `${prefix()}/changes${q({ since })}`),
  }
}

/** 固定在某个工作空间上的笔记接口：同步引擎用它，切换工作空间后旧引擎里还没完成的请求仍发往原来的工作空间。 */
export type WorkspaceApi = ReturnType<typeof notesApi>

export function workspaceApi(ws: string): WorkspaceApi {
  const prefix = apiPrefix(ws)
  return notesApi(() => prefix)
}

/** 界面用的客户端：笔记相关接口发往当前工作空间（见 lib/workspace），其余是全局接口。 */
export const api = { ...globalApi, ...notesApi(() => apiPrefix(currentWorkspace())) }

/** 当前工作空间里 vault 文件的访问 URL。 */
export function fileUrl(path: string): string {
  return `${apiPrefix(currentWorkspace())}/files/` + path.split('/').map(encodeURIComponent).join('/')
}

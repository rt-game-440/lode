/**
 * 工作空间（docs/workspaces.md 第 8 节）：地址前缀、本机存储的键名和 IndexedDB 名称。
 *
 * 默认工作空间（id `default`）一律沿用原来的名字，保持现有 URL、书签、离线数据和本机记忆不变；
 * 其他工作空间在页面路径前加 `/w/<id>`、API 前加 `/api/w/<id>`、存储键名后加 `:<id>`。
 *
 * 当前工作空间的 id 也放在这里（模块级变量），API 客户端和路由按它拼前缀；
 * 只有 stores/workspace 的切换流程会改它，界面通过 useWorkspace 读取。
 */

export const DEFAULT_WORKSPACE = 'default'

/** 默认工作空间在列表还没载入（离线冷启动）时显示的名称，与服务端登记表里的默认名称一致。 */
export const DEFAULT_WORKSPACE_NAME = '笔记'

export function isDefaultWorkspace(ws: string): boolean {
  return ws === DEFAULT_WORKSPACE
}

/** API 前缀：默认工作空间是 `/api`，其他是 `/api/w/<id>`。只用于按工作空间区分的接口（docs/api.md）。 */
export function apiPrefix(ws: string): string {
  return isDefaultWorkspace(ws) ? '/api' : `/api/w/${encodeURIComponent(ws)}`
}

/** 页面路径前缀：默认工作空间为空，其他是 `/w/<id>`。 */
export function routePrefix(ws: string): string {
  return isDefaultWorkspace(ws) ? '' : `/w/${encodeURIComponent(ws)}`
}

/** 给工作空间内的页面路径（如 `/note/abc`、`/`）加上前缀。其他工作空间的首页是 `/w/<id>`。 */
export function workspacePath(ws: string, path: string): string {
  const prefix = routePrefix(ws)
  if (!prefix) return path || '/'
  return path === '/' || path === '' ? prefix : prefix + path
}

/** 拆出页面路径里的工作空间：`/w/k3f9a2/note/x` → `{ ws: 'k3f9a2', rest: '/note/x' }`；没有前缀的是默认工作空间。 */
export function splitWorkspacePath(pathname: string): { ws: string; rest: string } {
  const m = /^\/w\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!m) return { ws: DEFAULT_WORKSPACE, rest: pathname || '/' }
  let ws: string
  try {
    ws = decodeURIComponent(m[1])
  } catch {
    ws = m[1]
  }
  return { ws: ws || DEFAULT_WORKSPACE, rest: m[2] && m[2] !== '/' ? m[2] : '/' }
}

/** 从 API 地址里认出它属于哪个工作空间（全局接口返回 null）。 */
export function workspaceOfApiUrl(url: string): string | null {
  const m = /^\/api\/w\/([^/?#]+)/.exec(url)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** 按工作空间区分的 localStorage 键名：默认工作空间沿用原键名，其他加 `:<id>` 后缀。 */
export function storageKey(base: string, ws: string): string {
  return isDefaultWorkspace(ws) ? base : `${base}:${ws}`
}

/** 按工作空间区分的本机记忆。主题、布局、字号、编辑器偏好是全局的，不在这里。 */
export const WORKSPACE_STORAGE = {
  /** 最近打开的笔记（快速切换器的排序） */
  recent: 'lode.recent',
  /** 文件树展开的文件夹 */
  expanded: 'lode.expanded',
  /** 当前助手对话 */
  agentChat: 'lode.agent.chat',
} as const

/** IndexedDB 名称（笔记树快照、正文缓存、离线写队列）：默认工作空间沿用 `lode`，其他是 `lode:<id>`。 */
export function localDbName(ws: string): string {
  return storageKey('lode', ws)
}

// ---- 当前工作空间 ----

let current = typeof location === 'undefined' ? DEFAULT_WORKSPACE : splitWorkspacePath(location.pathname).ws

/** 当前工作空间的 id。启动时取自地址栏，之后只由切换流程修改。 */
export function currentWorkspace(): string {
  return current
}

/** 只给 stores/workspace 的切换流程和单测用。 */
export function setCurrentWorkspace(ws: string) {
  current = ws || DEFAULT_WORKSPACE
}

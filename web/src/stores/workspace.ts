import { create } from 'zustand'
import { ApiError, api, errorMessage, setWorkspaceMissingHandler } from '../api/client'
import type { WorkspaceInfo } from '../api/types'
import {
  DEFAULT_WORKSPACE,
  DEFAULT_WORKSPACE_NAME,
  currentWorkspace,
  isDefaultWorkspace,
  WORKSPACE_STORAGE,
  localDbName,
  setCurrentWorkspace,
  splitWorkspacePath,
  storageKey,
} from '../lib/workspace'
import { switchSyncEngine, sync } from '../sync/engine'
import { LocalDB } from '../sync/localdb'
import { useAgent } from './agent'
import { editorBridge, useEditor } from './editor'
import { type Route, useUI } from './ui'
import { flushTreeCache, resetVault, useVault } from './vault'

/** 工作空间列表的本机缓存（全局键）：离线冷启动时也能显示名称、切换到缓存过的工作空间。 */
const LIST_KEY = 'lode.workspaces'

const DEFAULT_INFO: WorkspaceInfo = { id: DEFAULT_WORKSPACE, name: DEFAULT_WORKSPACE_NAME, external: false, path: 'vault', sort: 0, created_at: 0, note_count: 0 }

function loadCachedList(): WorkspaceInfo[] {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]')
    if (Array.isArray(v) && v.some((w) => w?.id === DEFAULT_WORKSPACE)) return v
  } catch {
    /* 缓存损坏：用默认 */
  }
  return [DEFAULT_INFO]
}

function cacheList(list: WorkspaceInfo[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list))
  } catch {
    /* 存储已满或被禁用：只是缓存 */
  }
}

/** 列表的版本号：每次载入或本地修改加一，用来丢弃过期的载入结果 */
let listSeq = 0

function setList(list: WorkspaceInfo[]) {
  listSeq++
  useWorkspace.setState({ list })
  cacheList(list)
}

/** 清掉已删除工作空间的本机数据：笔记树和正文缓存、离线写队列、本机记忆。 */
async function forgetLocalData(id: string) {
  for (const base of Object.values(WORKSPACE_STORAGE)) {
    try {
      localStorage.removeItem(storageKey(base, id))
    } catch {
      /* 存储被禁用：没有可清的 */
    }
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(localDbName(id))
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** 工作空间的显示名称；列表里没有时默认工作空间叫“笔记”，其他显示 id。 */
export function workspaceName(list: WorkspaceInfo[], id: string): string {
  return list.find((w) => w.id === id)?.name ?? (isDefaultWorkspace(id) ? DEFAULT_WORKSPACE_NAME : id)
}

export interface SwitchOptions {
  /** 切换后打开的页面，默认是新工作空间的首页 */
  route?: Route
  /**
   * 地址栏怎么变：push（默认，可以用后退回到原来的工作空间）、replace，
   * none 表示地址栏已经变了（浏览器前进后退），只按它更新页面。
   */
  history?: 'push' | 'replace' | 'none'
}

interface WorkspaceState {
  /** 当前工作空间 id（与 lib/workspace 的 currentWorkspace() 一致，供界面订阅） */
  current: string
  /** 全部工作空间，按 sort 排序，默认工作空间在最前 */
  list: WorkspaceInfo[]
  /** 从服务器刷新列表（失败时保留缓存） */
  load: () => Promise<void>
  /** 新建内置工作空间（不切换），返回登记信息 */
  create: (name: string) => Promise<WorkspaceInfo>
  /** 重命名（默认工作空间也可以）。名称由服务端校验，不合法时抛出错误。 */
  rename: (id: string, name: string) => Promise<void>
  /** 把工作空间移到列表里的第 pos 位（从 0 开始）；先更新界面，失败时恢复并抛出错误。 */
  reorder: (id: string, pos: number) => Promise<void>
  /**
   * 删除工作空间（默认工作空间不能删除）：服务端把目录移到数据目录的 trash-workspaces/ 下并作废绑定的 token，
   * 这里再清掉它的本机缓存。删除的是当前工作空间时，先回到默认工作空间的“工作空间”设置页。返回作废的 token 数。
   */
  remove: (id: string) => Promise<number>
  /**
   * 切换到另一个工作空间：先把编辑器里没保存的修改交给当前的同步引擎，再销毁它（WebSocket 断开、写队列留在本机），
   * 清空笔记树、编辑器和助手的状态，换上新工作空间的同步引擎并载入笔记树。
   */
  switchTo: (id: string, opts?: SwitchOptions) => Promise<void>
}

/** 切换串行执行：连点两次时第二次等第一次完成 */
let switching: Promise<void> = Promise.resolve()

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  current: currentWorkspace(),
  list: loadCachedList(),

  load: async () => {
    const seq = ++listSeq
    let list: WorkspaceInfo[]
    try {
      list = await api.workspaces()
    } catch {
      return
    }
    // 请求期间列表被本地修改（新建、改名、排序、删除）过：这份结果可能是修改之前的，丢掉
    if (seq !== listSeq) return
    if (!list.some((w) => w.id === DEFAULT_WORKSPACE)) list = [DEFAULT_INFO, ...list]
    set({ list })
    cacheList(list)
    const cur = get().current
    if (!list.some((w) => w.id === cur)) workspaceMissing(cur)
  },

  create: async (name) => {
    const info = await api.createWorkspace(name)
    setList([...get().list.filter((w) => w.id !== info.id), info].sort((a, b) => a.sort - b.sort))
    return info
  },

  rename: async (id, name) => {
    const info = await api.updateWorkspace(id, { name })
    setList(get().list.map((w) => (w.id === id ? { ...w, ...info } : w)))
  },

  reorder: async (id, pos) => {
    const before = get().list
    const from = before.findIndex((w) => w.id === id)
    if (from < 0) return
    const next = [...before]
    const [moved] = next.splice(from, 1)
    next.splice(Math.min(Math.max(pos, 0), next.length), 0, moved)
    setList(next.map((w, i) => ({ ...w, sort: i })))
    try {
      await api.updateWorkspace(id, { sort: pos })
    } catch (err) {
      setList(before)
      throw err
    }
  },

  remove: async (id) => {
    if (isDefaultWorkspace(id)) throw new Error('默认工作空间不能删除')
    // 先离开：免得删除后同步引擎的重连请求打到已不存在的工作空间
    if (get().current === id) {
      await get().switchTo(DEFAULT_WORKSPACE, { route: { view: 'settings', sub: ['workspaces'] }, history: 'replace' })
    }
    const res = await api.deleteWorkspace(id)
    setList(get().list.filter((w) => w.id !== id))
    await forgetLocalData(id)
    return res.revoked_tokens
  },

  switchTo: (id, opts = {}) => {
    const run = switching.then(() => doSwitch(id, opts))
    switching = run.catch(() => {})
    return run
  },
}))

async function doSwitch(id: string, { route = { view: 'home' }, history = 'push' }: SwitchOptions) {
  const ui = useUI.getState()
  if (id === currentWorkspace()) {
    if (history === 'none') ui.syncFromLocation()
    else ui.navigate(route, history === 'replace')
    return
  }
  // 1. 编辑器里还没交给同步引擎的修改先交给当前工作空间（离线时进入它的写队列），笔记树缓存也写进去
  await editorBridge.current?.flush().catch(() => {})
  flushTreeCache()

  // 2. 换工作空间：之后的接口调用、页面地址、本机记忆都用新的 id
  setCurrentWorkspace(id)
  useWorkspace.setState({ current: id })
  useEditor.getState().close()
  useEditor.setState({ revs: {} })
  resetVault()
  useAgent.getState().switchWorkspace()
  useUI.setState({ agentPopup: false, switcherOpen: false })

  // 3. 销毁旧的同步引擎，换上新工作空间的（已启动时新引擎立即连接并补发它自己的写队列）
  switchSyncEngine(id)

  // 4. 地址栏和页面
  if (history === 'none') ui.syncFromLocation()
  else ui.navigate(route, history === 'replace')

  // 5. 载入笔记树（离线时用缓存），顺便刷新工作空间列表
  await loadTree()
  void useWorkspace.getState().load()
}

/** 载入当前工作空间的笔记树；失败时提示并可以重试。 */
export async function loadTree() {
  try {
    await useVault.getState().load()
  } catch (err) {
    // 工作空间不存在时 API 客户端已经提示并切回默认工作空间（见 workspaceMissing）
    if (err instanceof ApiError && err.code === 'workspace_not_found') return
    useUI.getState().toast({
      message: `笔记列表加载失败：${errorMessage(err)}`,
      tone: 'error',
      action: { label: '重试', run: () => void loadTree() },
    })
  }
}

/** 浏览器前进后退：地址栏换了工作空间就先切换，否则只更新页面。 */
export function syncWorkspaceFromLocation() {
  const { ws } = splitWorkspacePath(location.pathname)
  if (ws !== currentWorkspace()) void useWorkspace.getState().switchTo(ws, { history: 'none' })
  else useUI.getState().syncFromLocation()
}

/** 当前工作空间不存在（地址写错或已被删除）：回到默认工作空间。 */
function workspaceMissing(ws: string) {
  if (ws !== currentWorkspace() || isDefaultWorkspace(ws)) return
  useUI.getState().toast({ message: `工作空间不存在，已回到“${workspaceName(useWorkspace.getState().list, DEFAULT_WORKSPACE)}”`, tone: 'error' })
  void useWorkspace.getState().switchTo(DEFAULT_WORKSPACE, { history: 'replace' })
}

setWorkspaceMissingHandler(workspaceMissing)

/**
 * 清除所有工作空间的离线缓存（笔记树和正文，退出登录时）；各自的写队列保留，重新登录后补发。
 */
export async function clearAllLocalCaches() {
  const ids = new Set([DEFAULT_WORKSPACE, currentWorkspace(), ...useWorkspace.getState().list.map((w) => w.id)])
  await Promise.all(
    [...ids].map(async (id) => {
      if (id === sync.workspace) return sync.db.clearCache().catch(() => {})
      const db = new LocalDB(localDbName(id))
      await db.clearCache().catch(() => {})
      await db.close()
    }),
  )
}

import { create } from 'zustand'
import { api } from '../api/client'
import type { Change, MoveResult, Note, TagCount } from '../api/types'
import { dirname, join } from '../lib/paths'
import { currentWorkspace } from '../lib/workspace'
import { sync } from '../sync/engine'
import { useEditor } from './editor'

/**
 * 笔记树。所有读写都经过同步引擎（sync），这里只维护界面要用的列表。
 */
interface VaultState {
  loaded: boolean
  /** 当前显示的是离线缓存 */
  fromCache: boolean
  /** 笔记内容或结构每变化一次加一，供反链、搜索等派生数据刷新 */
  version: number
  folders: string[]
  notes: Record<string, Note>
  tags: TagCount[]

  load: () => Promise<void>
  upsert: (n: Note) => void
  remove: (id: string) => void
  refreshTags: () => Promise<void>

  createNote: (dir: string, name?: string) => Promise<Note>
  moveNote: (id: string, newPath: string) => Promise<MoveResult>
  deleteNote: (id: string) => Promise<void>
  restoreNote: (id: string) => Promise<Note>
  createFolder: (path: string) => Promise<void>
  moveFolder: (from: string, to: string) => Promise<void>
  deleteFolder: (path: string) => Promise<number>
}

export const useVault = create<VaultState>((set, get) => ({
  loaded: false,
  fromCache: false,
  version: 0,
  folders: [],
  notes: {},
  tags: [],

  load: async () => {
    const engine = sync
    const t = await engine.loadTree()
    // 等待期间切换了工作空间：这是旧工作空间的树，丢掉
    if (engine !== sync) return
    const notes: Record<string, Note> = {}
    for (const n of t.notes) notes[n.id] = n
    set((s) => ({ loaded: true, fromCache: t.fromCache, folders: t.folders, notes, version: s.version + 1 }))
    if (!t.fromCache) void get().refreshTags()
  },

  upsert: (n) => {
    // 只保留元数据，不把正文放进列表
    const { id, path, title, rev, hash, size, mtime, created_at, updated_at } = n
    set((s) => ({ notes: { ...s.notes, [id]: { id, path, title, rev, hash, size, mtime, created_at, updated_at } } }))
  },
  remove: (id) =>
    set((s) => {
      const notes = { ...s.notes }
      delete notes[id]
      return { notes }
    }),

  refreshTags: async () => {
    const ws = currentWorkspace()
    try {
      const tags = await api.tags()
      if (ws === currentWorkspace()) set({ tags })
    } catch {
      /* 忽略：标签只是辅助信息 */
    }
  },

  createNote: async (dir, name = '未命名') => {
    const n = await sync.createNote(join(dir, `${name}.md`), '', true)
    get().upsert(n)
    return n
  },

  moveNote: async (id, newPath) => {
    const res = await sync.moveNote(id, newPath)
    get().upsert(res.note)
    for (const u of res.updated) get().upsert(u)
    await useEditor.getState().syncServerNotes([res.note, ...res.updated])
    const dir = dirname(newPath)
    if (dir && !get().folders.includes(dir)) await get().load()
    contentChanged()
    return res
  },

  deleteNote: async (id) => {
    await sync.deleteNote(id)
    get().remove(id)
    contentChanged()
  },

  restoreNote: async (id) => {
    const n = await sync.restoreNote(id)
    get().upsert(n)
    contentChanged()
    return n
  },

  createFolder: async (path) => {
    await sync.createFolder(path)
    await get().load()
  },

  moveFolder: async (from, to) => {
    const res = await sync.moveFolder(from, to)
    await get().load()
    await useEditor.getState().syncServerNotes(res.updated)
  },

  deleteFolder: async (path) => {
    const r = await sync.deleteFolder(path)
    await get().load()
    return r.trashed
  },
}))

/** 按路径查找笔记。 */
export function findByPath(notes: Record<string, Note>, path: string): Note | undefined {
  const lower = path.toLowerCase()
  for (const n of Object.values(notes)) if (n.path.toLowerCase() === lower) return n
  return undefined
}

// ---- 与同步引擎的衔接 ----

/** 本机已经知道这条变更（自己写入的回声，或已经载入过的版本）。 */
sync.isKnown = (c: Change) => {
  const n = useVault.getState().notes[c.id]
  if (c.type === 'delete') return !n
  return !!n && n.rev >= c.rev && n.path === c.path
}

let changeTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 笔记内容有变化：稍后刷新标签和依赖内容的派生数据（反链、搜索结果等）。
 * 本机的删除、恢复、移动也要调用：它们的 WebSocket 回声会被 isKnown 当成已知而忽略。
 */
function contentChanged() {
  if (changeTimer) clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    useVault.setState((s) => ({ version: s.version + 1 }))
    void useVault.getState().refreshTags()
  }, 300)
}

sync.on('remote', async (changes) => {
  const v = useVault.getState()
  // 只是已知笔记的正文更新时直接改 rev；新建、移动、删除重拉整棵树（文件夹也可能变化）
  const structural = changes.some((c) => c.type !== 'upsert' || !v.notes[c.id] || v.notes[c.id].path !== c.path)
  if (structural) {
    await v.load().catch(() => {})
  } else {
    for (const c of changes) {
      const n = useVault.getState().notes[c.id]
      if (n && c.rev > n.rev) v.upsert({ ...n, rev: c.rev, updated_at: c.created_at })
    }
  }
  contentChanged()
})

sync.on('gone', () => useVault.getState().load().catch(() => {}))

sync.on('applied', ({ result }) => {
  useVault.getState().upsert(result)
  contentChanged()
})

sync.on('recovered', ({ id, note }) => {
  useVault.getState().remove(id)
  useVault.getState().upsert(note)
  contentChanged()
})

// 笔记树变化后更新离线缓存
let cacheTimer: ReturnType<typeof setTimeout> | null = null
useVault.subscribe((s, prev) => {
  if (!s.loaded || s.fromCache || (s.notes === prev.notes && s.folders === prev.folders)) return
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = setTimeout(() => {
    const { folders, notes, loaded, fromCache } = useVault.getState()
    if (loaded && !fromCache) sync.cacheTree(folders, Object.values(notes))
  }, 500)
})

/** 切换工作空间：清空笔记树，等新工作空间的树载入（还没写进缓存的旧树变化已在切换前写入，见 stores/workspace）。 */
export function resetVault() {
  if (changeTimer) clearTimeout(changeTimer)
  if (cacheTimer) clearTimeout(cacheTimer)
  changeTimer = cacheTimer = null
  useVault.setState((s) => ({ loaded: false, fromCache: false, folders: [], notes: {}, tags: [], version: s.version + 1 }))
}

/** 立即把待写的笔记树缓存写进当前引擎的 IndexedDB（切换工作空间之前调用）。 */
export function flushTreeCache() {
  if (!cacheTimer) return
  clearTimeout(cacheTimer)
  cacheTimer = null
  const { folders, notes, loaded, fromCache } = useVault.getState()
  if (loaded && !fromCache) sync.cacheTree(folders, Object.values(notes))
}

import { create } from 'zustand'
import { api } from '../api/client'
import type { Change, MoveResult, Note, TagCount } from '../api/types'
import { deviceId } from '../lib/device'
import { join } from '../lib/paths'

/**
 * 笔记树与所有写操作的入口。编辑器和文件树都通过这里读写笔记，
 * 阶段 2 会在这一层接入同步引擎（离线队列、WebSocket）。
 */
interface VaultState {
  loaded: boolean
  folders: string[]
  notes: Record<string, Note>
  seq: number
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

  /** 拉取 seq 之后的变更；有其他来源的变更时刷新树，并返回这些变更。 */
  poll: () => Promise<Change[]>
}

export const useVault = create<VaultState>((set, get) => ({
  loaded: false,
  folders: [],
  notes: {},
  seq: 0,
  tags: [],

  load: async () => {
    const t = await api.tree()
    const notes: Record<string, Note> = {}
    for (const n of t.notes) notes[n.id] = n
    set({ loaded: true, folders: t.folders, notes, seq: Math.max(get().seq, t.seq) })
    void get().refreshTags()
  },

  upsert: (n) => set((s) => ({ notes: { ...s.notes, [n.id]: n } })),
  remove: (id) =>
    set((s) => {
      const notes = { ...s.notes }
      delete notes[id]
      return { notes }
    }),

  refreshTags: async () => {
    try {
      set({ tags: await api.tags() })
    } catch {
      /* 忽略：标签只是辅助信息 */
    }
  },

  createNote: async (dir, name = '未命名') => {
    const n = await api.createNote(join(dir, `${name}.md`), '', true)
    get().upsert(n)
    return n
  },

  moveNote: async (id, newPath) => {
    const res = await api.moveNote(id, newPath)
    get().upsert(res.note)
    for (const u of res.updated) get().upsert(u)
    const dir = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : ''
    if (dir && !get().folders.includes(dir)) await get().load()
    return res
  },

  deleteNote: async (id) => {
    await api.deleteNote(id)
    get().remove(id)
    void get().refreshTags()
  },

  restoreNote: async (id) => {
    const n = await api.restore(id)
    get().upsert(n)
    void get().refreshTags()
    return n
  },

  createFolder: async (path) => {
    await api.createFolder(path)
    await get().load()
  },

  moveFolder: async (from, to) => {
    await api.moveFolder(from, to)
    await get().load()
  },

  deleteFolder: async (path) => {
    const r = await api.deleteFolder(path)
    await get().load()
    return r.trashed
  },

  poll: async () => {
    const { changes, seq } = await api.changes(get().seq)
    if (!changes.length) {
      if (seq > get().seq) set({ seq })
      return []
    }
    const me = deviceId()
    const foreign = changes.filter((c) => c.device_id !== me)
    set({ seq: Math.max(seq, changes[changes.length - 1].seq) })
    if (foreign.length) await get().load()
    return foreign
  },
}))

/** 按路径查找笔记。 */
export function findByPath(notes: Record<string, Note>, path: string): Note | undefined {
  const lower = path.toLowerCase()
  for (const n of Object.values(notes)) if (n.path.toLowerCase() === lower) return n
  return undefined
}

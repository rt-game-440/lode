import { create } from 'zustand'
import { ApiError, api, errorMessage } from '../api/client'
import type { Note, NoteContent } from '../api/types'
import type { SaveStatus } from '../lib/autosave'
import { useVault } from './vault'

export interface Heading {
  level: number
  text: string
  /** 从 1 开始的行号 */
  line: number
}

/** 当前打开的笔记。正文的实时内容在 CodeMirror 里，这里保存服务器确认过的版本。 */
interface EditorState {
  noteId: string | null
  doc: NoteContent | null
  /** 每次需要编辑器整体载入内容时递增（打开笔记、载入外部修改） */
  docVersion: number
  /** 各笔记最近一次与服务器一致的 rev，保存时作为 base_rev */
  revs: Record<string, number>
  status: SaveStatus
  error: string | null
  loading: boolean
  notFound: boolean
  /** 本地有未保存的修改时，服务器上出现了别处的修改 */
  stale: boolean
  headings: Heading[]

  open: (id: string) => Promise<void>
  close: () => void
  /** 保存正文（由 Autosaver 调用） */
  save: (id: string, content: string) => Promise<void>
  setStatus: (s: SaveStatus, err?: unknown) => void
  /** 服务器上的版本更新了（外部修改）；本地没有未保存的修改时载入 */
  reload: () => Promise<void>
  /** 放弃本地修改，载入服务器上的最新版本 */
  forceReload: () => Promise<void>
  /** 本机的操作（如重命名后改写链接）在服务器上修改了这些笔记；当前打开的笔记在其中时重新载入 */
  syncServerNotes: (notes: Note[]) => Promise<void>
  setHeadings: (h: Heading[]) => void
}

export const useEditor = create<EditorState>((set, get) => ({
  noteId: null,
  doc: null,
  docVersion: 0,
  revs: {},
  status: 'idle',
  error: null,
  loading: false,
  notFound: false,
  stale: false,
  headings: [],

  open: async (id) => {
    if (get().noteId === id && (get().doc || get().loading)) return
    set({ noteId: id, doc: null, loading: true, notFound: false, error: null, status: 'idle', stale: false, headings: [] })
    try {
      const doc = await api.readNote(id)
      if (get().noteId !== id) return
      set((s) => ({ doc, loading: false, revs: { ...s.revs, [id]: doc.rev }, docVersion: s.docVersion + 1 }))
    } catch (err) {
      if (get().noteId !== id) return
      set({ loading: false, doc: null, notFound: err instanceof ApiError && err.status === 404, error: errorMessage(err) })
    }
  },

  close: () => set({ noteId: null, doc: null, status: 'idle', error: null, stale: false, headings: [] }),

  save: async (id, content) => {
    const rev = get().revs[id]
    const res = await api.updateNote(id, rev ?? 0, content)
    set((s) => ({ revs: { ...s.revs, [id]: res.rev }, ...(s.noteId === id ? { doc: res } : {}) }))
    useVault.getState().upsert(res)
  },

  setStatus: (status, err) =>
    set({
      status,
      error: err ? errorMessage(err) : status === 'error' ? get().error : null,
      ...(err instanceof ApiError && err.code === 'conflict' ? { stale: true } : {}),
    }),

  reload: async () => {
    const id = get().noteId
    if (!id || get().loading) return
    try {
      const doc = await api.readNote(id)
      const s = get()
      if (s.noteId !== id || doc.rev === s.revs[id]) return
      if (s.status === 'dirty' || s.status === 'saving' || s.status === 'error') {
        set({ stale: true })
        return
      }
      set((st) => ({ doc, revs: { ...st.revs, [id]: doc.rev }, docVersion: st.docVersion + 1, stale: false }))
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && get().noteId === id) set({ notFound: true, doc: null })
    }
  },

  forceReload: async () => {
    const id = get().noteId
    if (!id) return
    const doc = await api.readNote(id)
    if (get().noteId !== id) return
    set((st) => ({
      doc,
      revs: { ...st.revs, [id]: doc.rev },
      docVersion: st.docVersion + 1,
      stale: false,
      status: 'idle',
      error: null,
    }))
  },

  syncServerNotes: async (notes) => {
    const id = get().noteId
    const n = id ? notes.find((x) => x.id === id) : undefined
    if (n && n.rev !== get().revs[n.id]) await get().reload()
  },

  setHeadings: (headings) => set({ headings }),
}))

/** 从 Markdown 文本提取标题（跳过代码块和 frontmatter）。 */
export function extractHeadings(text: string): Heading[] {
  const out: Heading[] = []
  const lines = text.split('\n')
  let fence: string | null = null
  let i = 0
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length; i++) if (lines[i].trim() === '---') break
    i++
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m && m[2]) out.push({ level: m[1].length, text: m[2], line: i + 1 })
  }
  return out
}

import { create } from 'zustand'
import { ApiError, errorMessage } from '../api/client'
import type { Note, NoteContent } from '../api/types'
import type { SaveStatus } from '../lib/autosave'
import { noteTitle } from '../lib/paths'
import { sync } from '../sync/engine'
import { useUI } from './ui'
import { useVault } from './vault'

export interface Heading {
  level: number
  text: string
  /** 从 1 开始的行号 */
  line: number
}

/**
 * 编辑器组件向 store 暴露的操作（组件挂载时注册）。
 * 正文的实时内容只在 CodeMirror 里，store 通过这些回调把服务器的新版本套进去。
 */
export interface EditorBridge {
  /**
   * 把服务器版本 next 套到编辑器上。base 是 next 与编辑器内容的共同祖先（null 表示就是编辑器当前内容）。
   * 编辑器在 base 之后还有修改时做变基并重新保存；正在用输入法组字时推迟到组字结束。
   */
  applyRemote: (id: string, base: string | null, next: string) => void
  /** 编辑器里是否有尚未交给同步引擎的修改 */
  isDirty: () => boolean
  /** 尽快保存（不打断输入法组字） */
  saveSoon: () => void
  /** 丢弃尚未交给同步引擎的修改，返回被丢弃的全文（没有则为 null） */
  discardPending: () => string | null
  /** 立即把尚未交给同步引擎的修改交出去（切换工作空间前调用；离线时进入写队列） */
  flush: () => Promise<void>
}

export const editorBridge: { current: EditorBridge | null } = { current: null }

/** 当前打开的笔记。正文的实时内容在 CodeMirror 里，这里保存与服务器一致的版本。 */
interface EditorState {
  noteId: string | null
  doc: NoteContent | null
  /** 每次需要编辑器整体载入内容时递增（打开笔记） */
  docVersion: number
  /** 各笔记编辑器内容所基于的服务器 rev，保存时作为 base_rev */
  revs: Record<string, number>
  status: SaveStatus
  error: string | null
  loading: boolean
  notFound: boolean
  headings: Heading[]

  open: (id: string) => Promise<void>
  close: () => void
  /** 保存正文（由 Autosaver 调用） */
  save: (id: string, content: string) => Promise<void>
  setStatus: (s: SaveStatus, err?: unknown) => void
  /** 服务器上的版本可能更新了：本地没有未保存的修改就载入，有修改就立即保存让服务器合并 */
  reload: () => Promise<void>
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
  headings: [],

  open: async (id) => {
    sync.dismissConflict(id) // 打开冲突副本即视为已查看
    if (get().noteId === id && (get().doc || get().loading)) return
    set({ noteId: id, doc: null, loading: true, notFound: false, error: null, status: 'idle', headings: [] })
    try {
      const { doc, baseRev } = await sync.readNote(id)
      if (get().noteId !== id) return
      set((s) => ({ doc, loading: false, revs: { ...s.revs, [id]: baseRev }, docVersion: s.docVersion + 1 }))
    } catch (err) {
      if (get().noteId !== id) return
      set({ loading: false, doc: null, notFound: err instanceof ApiError && err.status === 404, error: errorMessage(err) })
    }
  },

  close: () => set({ noteId: null, doc: null, status: 'idle', error: null, headings: [] }),

  save: async (id, content) => {
    const note = useVault.getState().notes[id] ?? (get().doc?.id === id ? get().doc : null)
    if (!note) return
    const base = sync.pendingFor(id)?.baseRev ?? get().revs[id] ?? note.rev
    await sync.save({ id, path: note.path }, content, base)
  },

  setStatus: (status, err) => set({ status, error: err ? errorMessage(err) : status === 'error' ? get().error : null }),

  reload: async () => {
    const id = get().noteId
    if (!id || get().loading || !get().doc) return
    if (pushLocal(id)) return
    try {
      const { doc } = await sync.readNote(id)
      const s = get()
      if (s.noteId !== id || doc.rev === s.revs[id]) return
      if (pushLocal(id)) return
      set((st) => ({ doc, revs: { ...st.revs, [id]: doc.rev } }))
      editorBridge.current?.applyRemote(id, null, doc.content)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && get().noteId === id) set({ notFound: true, doc: null })
    }
  },

  syncServerNotes: async (notes) => {
    const id = get().noteId
    const n = id ? notes.find((x) => x.id === id) : undefined
    if (n && n.rev !== get().revs[n.id]) await get().reload()
  },

  setHeadings: (headings) => set({ headings }),
}))

// ---- 与同步引擎的衔接 ----

/**
 * 本地有未同步的修改时立即发送，由服务器三方合并，合并结果经 applied 事件套回编辑器。
 * 返回 false 表示本地没有未同步的修改。
 */
function pushLocal(id: string): boolean {
  const bridge = editorBridge.current
  if (bridge?.isDirty()) {
    bridge.saveSoon()
    return true
  }
  if (sync.pendingFor(id)) {
    void sync.drain()
    return true
  }
  return false
}

sync.on('applied', ({ id, sent, result }) => {
  useEditor.setState((s) => ({
    revs: { ...s.revs, [id]: result.rev },
    ...(s.noteId === id && s.doc ? { doc: { ...result, merged: undefined } } : {}),
  }))
  // 服务器合并了别处的修改：把合并结果套到编辑器上（编辑器在发送后又有修改时做变基）
  if (result.content !== sent && useEditor.getState().noteId === id) editorBridge.current?.applyRemote(id, sent, result.content)
})

sync.on('remote', async (changes) => {
  const s = useEditor.getState()
  const mine = s.noteId ? changes.filter((c) => c.id === s.noteId) : []
  if (!mine.length) return
  if (mine.some((c) => c.type === 'delete')) {
    useEditor.setState({ notFound: true, doc: null })
    return
  }
  if (mine.some((c) => c.type === 'upsert' && c.rev > (s.revs[c.id] ?? 0))) await s.reload()
})

sync.on('conflict', (c) => {
  const ui = useUI.getState()
  const name = noteTitle(c.path)
  const open = () => ui.navigate({ view: 'note', id: c.copyId }) // 打开副本即视为已查看
  if (c.remote) {
    ui.toast({ message: `“${name}”在另一台设备上与你的修改冲突，已生成冲突副本`, action: { label: '查看副本', run: open } })
    return
  }
  // 本机的写入与别处冲突：服务器版本不变，编辑器换成服务器版本，本地版本在冲突副本里
  const st = useEditor.getState()
  if (c.id && c.server && st.noteId === c.id) {
    // 还没交给同步引擎的修改是在冲突版本之上做的，也写进冲突副本
    const rest = editorBridge.current?.discardPending() ?? null
    if (rest !== null && c.copyId) {
      const base = sync.pendingFor(c.copyId)?.baseRev ?? st.revs[c.copyId] ?? 1
      void sync.save({ id: c.copyId, path: c.copyPath }, rest, base).catch(() => {})
    }
    useEditor.setState((s) => ({ doc: c.server!, revs: { ...s.revs, [c.id!]: c.server!.rev }, status: 'idle' }))
    editorBridge.current?.applyRemote(c.id, null, c.server.content)
  }
  ui.toast({
    message: `“${name}”与其他设备的修改冲突，你的版本已另存为冲突副本`,
    tone: 'error',
    action: c.copyId ? { label: '打开副本', run: open } : undefined,
  })
})

sync.on('recovered', ({ id, note }) => {
  const ui = useUI.getState()
  if (useEditor.getState().noteId === id) ui.navigate({ view: 'note', id: note.id })
  ui.toast({ message: `笔记已在别处删除，你的修改另存为“${note.title}”`, tone: 'error' })
})

sync.on('gone', () => useEditor.getState().reload())

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

import { ArrowLeft, FilePlus, FileText, Hash, PanelLeft, RotateCcw, Trash, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { Note, TrashItem } from '../../api/types'
import { confirmDialog } from '../../components/overlays'
import { Button, EmptyState, IconButton, Spinner } from '../../components/ui'
import { dirname } from '../../lib/paths'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { errorMessage, newNote, openNote } from '../actions'
import './views.css'

function ViewBar({ title, mobile }: { title: string; mobile: boolean }) {
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const navigate = useUI((s) => s.navigate)
  return (
    <header className="view-bar">
      {mobile ? (
        <IconButton label="返回" onClick={() => navigate({ view: 'home' })}>
          <ArrowLeft size={20} />
        </IconButton>
      ) : (
        !sidebarOpen && (
          <IconButton label="显示侧栏 (Ctrl+\)" onClick={() => toggleSidebar(true)}>
            <PanelLeft size={18} />
          </IconButton>
        )
      )}
      <h1 className="view-title">{title}</h1>
    </header>
  )
}

const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function NoteList({ notes }: { notes: Note[] }) {
  return (
    <ul className="note-list">
      {notes.map((n) => (
        <li key={n.id}>
          <button className="note-row" onClick={() => openNote(n.id)}>
            <FileText size={16} aria-hidden="true" />
            <span className="note-row-title">{n.title}</span>
            <span className="note-row-meta">{dirname(n.path)}</span>
            <span className="note-row-time">{timeFmt.format(n.mtime)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 没有打开笔记时的首页：最近修改的笔记。 */
export function HomeView() {
  const notes = useVault((s) => s.notes)
  const loaded = useVault((s) => s.loaded)
  const recent = useMemo(() => Object.values(notes).sort((a, b) => b.mtime - a.mtime).slice(0, 20), [notes])
  return (
    <section className="view">
      <ViewBar title="" mobile={false} />
      <div className="view-body home">
        <h1 className="home-title">笔记</h1>
        <div className="home-actions">
          <Button variant="primary" icon={<FilePlus size={16} />} onClick={() => void newNote('')}>
            新建笔记
          </Button>
          <Button variant="secondary" onClick={() => useUI.getState().setSwitcherOpen(true)}>
            快速打开 <kbd className="kbd">Ctrl K</kbd>
          </Button>
        </div>
        {loaded && !recent.length ? (
          <EmptyState icon={<FileText size={32} strokeWidth={1.5} />} title="还没有笔记">
            新建一篇，或把 Markdown 文件放进 vault 目录
          </EmptyState>
        ) : (
          <>
            <h2 className="section-title">最近修改</h2>
            <NoteList notes={recent} />
          </>
        )}
      </div>
    </section>
  )
}

/** 某个标签下的笔记（包含子标签）。 */
export function TagView({ tag, mobile }: { tag: string; mobile: boolean }) {
  const seq = useVault((s) => s.seq)
  const [notes, setNotes] = useState<Note[] | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .notesByTag(tag)
      .then((n) => !cancelled && setNotes(n))
      .catch(() => !cancelled && setNotes([]))
    return () => {
      cancelled = true
    }
  }, [tag, seq])
  return (
    <section className="view">
      <ViewBar title={`#${tag}`} mobile={mobile} />
      <div className="view-body">
        {!notes ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : notes.length ? (
          <NoteList notes={notes} />
        ) : (
          <EmptyState icon={<Hash size={28} strokeWidth={1.5} />} title="这个标签下没有笔记" />
        )}
      </div>
    </section>
  )
}

/** 回收站：恢复（保留原 id）或彻底删除。 */
export function TrashView({ mobile }: { mobile: boolean }) {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const toast = useUI((s) => s.toast)
  const restoreNote = useVault((s) => s.restoreNote)

  const load = useCallback(async () => {
    try {
      setItems(await api.trash())
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
      setItems([])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const restore = async (it: TrashItem) => {
    try {
      const n = await restoreNote(it.id)
      setItems((list) => list?.filter((x) => x.id !== it.id) ?? null)
      toast({
        message: n.path === it.path ? `已恢复“${n.title}”` : `已恢复为“${n.path}”`,
        action: { label: '打开', run: () => openNote(n.id) },
      })
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  const purge = async (it: TrashItem) => {
    const ok = await confirmDialog({
      title: `彻底删除“${it.title}”？`,
      message: '彻底删除后无法恢复。',
      confirmLabel: '彻底删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.purge(it.id)
      setItems((list) => list?.filter((x) => x.id !== it.id) ?? null)
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  const emptyAll = async () => {
    const ok = await confirmDialog({
      title: '清空回收站？',
      message: `回收站里的 ${items?.length ?? 0} 篇笔记将被彻底删除，无法恢复。`,
      confirmLabel: '清空',
      danger: true,
    })
    if (!ok) return
    try {
      await api.emptyTrash()
      setItems([])
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  return (
    <section className="view">
      <ViewBar title="回收站" mobile={mobile} />
      <div className="view-body">
        {!items ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !items.length ? (
          <EmptyState icon={<Trash size={32} strokeWidth={1.5} />} title="回收站是空的">
            删除的笔记会先放在这里
          </EmptyState>
        ) : (
          <>
            <div className="trash-head">
              <span>{items.length} 篇笔记</span>
              <Button size="sm" variant="secondary" onClick={() => void emptyAll()}>
                清空回收站
              </Button>
            </div>
            <ul className="note-list" aria-label="回收站">
              {items.map((it) => (
                <li key={it.id} className="trash-row">
                  <FileText size={16} aria-hidden="true" />
                  <div className="trash-info">
                    <span className="note-row-title">{it.title}</span>
                    <span className="note-row-meta">
                      {it.path} · 删除于 {timeFmt.format(it.deleted_at)}
                    </span>
                  </div>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => void restore(it)}>
                    恢复
                  </Button>
                  <IconButton label={`彻底删除“${it.title}”`} size="sm" onClick={() => void purge(it)}>
                    <X size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

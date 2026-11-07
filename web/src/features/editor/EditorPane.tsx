import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ArrowLeft, Ellipsis, FileText, PanelLeft, PanelRight, Pencil, RotateCcw, Trash } from 'lucide-react'
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { openMenu } from '../../components/overlays'
import { Button, EmptyState, IconButton, Spinner } from '../../components/ui'
import { Autosaver } from '../../lib/autosave'
import { dirname } from '../../lib/paths'
import { LinkResolver, linkTextFor } from '../../lib/wikilink'
import { extractHeadings, useEditor } from '../../stores/editor'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { deleteNote, errorMessage, openWikiLink, renameNote } from '../actions'
import { refreshPreview } from './cm/livePreview'
import { type EditorEnv, editorExtensions, replaceDoc } from './cm/setup'
import { editorRef, takeTitleFocus } from './editorRef'
import './editor.css'

const SAVE_DELAY = 500

const STATUS_TEXT = {
  idle: '',
  dirty: '编辑中',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
} as const

export function EditorPane({ id, mobile }: { id: string; mobile: boolean }) {
  const open = useEditor((s) => s.open)
  const doc = useEditor((s) => s.doc)
  const docVersion = useEditor((s) => s.docVersion)
  const loading = useEditor((s) => s.loading)
  const notFound = useEditor((s) => s.notFound)
  const status = useEditor((s) => s.status)
  const error = useEditor((s) => s.error)
  const stale = useEditor((s) => s.stale)
  const note = useVault((s) => s.notes[id])
  const notes = useVault((s) => s.notes)
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const toggleRight = useUI((s) => s.toggleRight)
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)

  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saverRef = useRef<Autosaver | null>(null)
  const loadedFor = useRef<{ id: string; version: number } | null>(null)
  const headingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 供 CodeMirror 扩展读取的最新状态
  const notesRef = useRef(notes)
  notesRef.current = notes
  const pathRef = useRef(note?.path ?? '')
  pathRef.current = note?.path ?? doc?.path ?? ''

  const resolver = useMemo(() => new LinkResolver(Object.values(notes).map((n) => n.path)), [notes])
  const resolverRef = useRef(resolver)
  resolverRef.current = resolver

  useEffect(() => {
    void open(id)
  }, [id, open])

  // 创建编辑器（只创建一次）
  useLayoutEffect(() => {
    const env: EditorEnv = {
      notePath: () => pathRef.current,
      linkExists: (target, src) => resolverRef.current.resolve(target, src) !== null,
      openWikiLink: (target) => void openWikiLink(target, pathRef.current),
      openTag: (tag) => tag && useUI.getState().navigate({ view: 'tag', tag }),
      candidates: () => {
        const all = Object.values(notesRef.current)
        const paths = all.map((n) => n.path)
        return all
          .filter((n) => n.path !== pathRef.current)
          .map((n) => ({ path: n.path, title: n.title, linkText: linkTextFor(n.path, paths) }))
      },
      upload: async (file) => {
        const res = await api.uploadAttachment(file, file.name && file.name !== 'image.png' ? file.name : undefined)
        return res.path
      },
      onUploadError: (err) => toast({ message: `图片上传失败：${errorMessage(err)}`, tone: 'error' }),
      onDocChange: (content) => {
        saverRef.current?.change(content)
        if (headingTimer.current) clearTimeout(headingTimer.current)
        headingTimer.current = setTimeout(() => useEditor.getState().setHeadings(extractHeadings(content)), 300)
      },
      onSave: () => void saverRef.current?.flush(),
    }
    const extensions = editorExtensions(env)
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: '', extensions }) })
    viewRef.current = view
    editorRef.view = view
    editorRef.extensions = extensions
    return () => {
      void saverRef.current?.flush()
      saverRef.current?.dispose()
      saverRef.current = null
      view.destroy()
      viewRef.current = null
      editorRef.view = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 载入内容：切换笔记时重建状态，同一笔记的外部修改做最小替换
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || !doc || doc.id !== id) return
    const prev = loadedFor.current
    if (prev && prev.id === id && prev.version === docVersion) return
    if (prev && prev.id === id) {
      replaceDoc(view, doc.content)
    } else {
      // 切换笔记：先保存上一篇
      const old = saverRef.current
      if (old) {
        void old.flush().finally(() => old.dispose())
      }
      const noteId = id
      saverRef.current = new Autosaver({
        delay: SAVE_DELAY,
        save: (content) => useEditor.getState().save(noteId, content),
        onStatus: (s, err) => {
          if (useEditor.getState().noteId === noteId) useEditor.getState().setStatus(s, err)
        },
        isComposing: () => viewRef.current?.composing ?? false,
      })
      view.setState(EditorState.create({ doc: doc.content, extensions: editorRef.extensions }))
      scrollRef.current?.scrollTo({ top: 0 })
      if (takeTitleFocus(id)) {
        titleRef.current?.focus()
        titleRef.current?.select()
      } else if (!mobile) {
        view.focus()
      }
    }
    loadedFor.current = { id, version: docVersion }
    useEditor.getState().setHeadings(extractHeadings(doc.content))
  }, [doc, docVersion, id, mobile])

  // 笔记列表变化后刷新链接的存在状态
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshPreview.of(null) })
  }, [resolver])

  // 页面隐藏或关闭前保存
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void saverRef.current?.flush()
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saverRef.current?.dirty) {
        void saverRef.current.flush()
        e.preventDefault()
      }
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  const showEditor = !!doc && doc.id === id && !notFound

  return (
    <section className="editor-pane" aria-label="编辑器">
      <header className="editor-bar">
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
        <div className="editor-crumb">{note && dirname(note.path) ? dirname(note.path).split('/').join(' / ') : ''}</div>
        <span className="spacer" />
        <SaveIndicator status={status} error={error} onRetry={() => void saverRef.current?.flush()} />
        <IconButton label={rightOpen ? '隐藏右栏' : '显示右栏'} active={rightOpen} onClick={() => toggleRight()}>
          <PanelRight size={18} />
        </IconButton>
        {note && (
          <IconButton
            label="更多操作"
            onClick={(e) =>
              openMenu(e.currentTarget, [
                {
                  label: '重命名',
                  icon: <Pencil size={16} />,
                  run: () => {
                    titleRef.current?.focus()
                    titleRef.current?.select()
                  },
                },
                { label: '移到回收站', icon: <Trash size={16} />, danger: true, run: () => void deleteNote(note) },
              ])
            }
          >
            <Ellipsis size={18} />
          </IconButton>
        )}
      </header>

      {stale && (
        <div className="editor-banner" role="alert">
          <span>这篇笔记已在别处被修改，你的修改尚未保存。</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={14} />}
            onClick={async () => {
              saverRef.current?.dispose()
              saverRef.current = null
              loadedFor.current = null
              try {
                await useEditor.getState().forceReload()
              } catch (err) {
                toast({ message: errorMessage(err), tone: 'error' })
              }
            }}
          >
            载入最新版本
          </Button>
        </div>
      )}

      <div className="editor-scroll" ref={scrollRef}>
        {note && showEditor && (
          <TitleInput
            key={note.id + note.title}
            ref={titleRef}
            title={note.title}
            onCommit={(v) => renameNote(note, v)}
            onEnter={() => viewRef.current?.focus()}
          />
        )}
        <div className="editor-host" ref={host} hidden={!showEditor} data-testid="editor" />
        {loading && !showEditor && (
          <div className="editor-loading">
            <Spinner size={20} />
          </div>
        )}
        {notFound && (
          <EmptyState icon={<FileText size={32} strokeWidth={1.5} />} title="笔记不存在">
            它可能已被删除或移到回收站。
          </EmptyState>
        )}
      </div>
    </section>
  )
}

function SaveIndicator({ status, error, onRetry }: { status: keyof typeof STATUS_TEXT; error: string | null; onRetry: () => void }) {
  if (status === 'idle') return <span className="save-status" aria-live="polite" />
  if (status === 'error') {
    return (
      <button className="save-status is-error" onClick={onRetry} title={error ?? undefined} aria-live="polite">
        {STATUS_TEXT.error}
        {error ? `：${error}` : ''} · 重试
      </button>
    )
  }
  return (
    <span className={`save-status is-${status}`} aria-live="polite" data-testid="save-status">
      {STATUS_TEXT[status]}
    </span>
  )
}

interface TitleProps {
  title: string
  onCommit: (v: string) => Promise<boolean>
  onEnter: () => void
}


const TitleInput = forwardRef<HTMLInputElement, TitleProps>(function TitleInput({ title, onCommit, onEnter }, ref) {
  const [value, setValue] = useState(title)
  const committing = useRef(false)
  const commit = async () => {
    if (committing.current) return
    const v = value.trim()
    if (!v || v === title) {
      setValue(title)
      return
    }
    committing.current = true
    const ok = await onCommit(v)
    committing.current = false
    if (!ok) setValue(title)
  }
  return (
    <input
      ref={ref}
      className="editor-title"
      aria-label="笔记标题"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
          onEnter()
        } else if (e.key === 'Escape') {
          setValue(title)
          onEnter()
        }
      }}
    />
  )
})

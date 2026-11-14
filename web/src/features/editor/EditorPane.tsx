import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ArrowLeft, CaseSensitive, Ellipsis, Eye, FileText, PanelRight, Pencil, Sparkles, Trash } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { openMenu } from '../../components/overlays'
import { EmptyState, IconButton, Spinner } from '../../components/ui'
import { Autosaver } from '../../lib/autosave'
import { dirname } from '../../lib/paths'
import { LinkResolver, linkTextFor } from '../../lib/wikilink'
import { editorBridge, extractHeadings, useEditor } from '../../stores/editor'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { fadeTransition, springDefault } from '../../styles/tokens/motion'
import { deleteNote, errorMessage, openWikiLink, renameNote } from '../actions'
import { refreshPreview } from './cm/livePreview'
import { sync } from '../../sync/engine'
import { diffChangeSet, rebase } from '../../sync/textdiff'
import { type EditorEnv, browseCompartment, browseExtension, editorExtensions, remoteSync } from './cm/setup'
import { editorRef, takeTitleFocus } from './editorRef'
import { useReadingPosition } from './useReadingPosition'
import { useEditorPrefs } from '../../stores/editorPrefs'
import { useBrowseMode } from '../../stores/browseMode'
import { PanelToggleSlot } from '../shell/PanelToggle'
import { useNoteAppearance } from '../../stores/noteAppearance'
import { AppearancePanelHost, closeAppearancePanel, openAppearancePanel } from './AppearancePanel'
import { bodyStart } from './cm/appearance'
import { FormatToolbar } from './FormatToolbar'
import { TocRail } from './TocRail'
import { MobileToolbar } from './MobileToolbar'
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
  const note = useVault((s) => s.notes[id])
  const notes = useVault((s) => s.notes)
  const rightOpen = useUI((s) => s.rightOpen)
  const toggleRight = useUI((s) => s.toggleRight)
  const agentPopup = useUI((s) => s.agentPopup)
  const setAgentPopup = useUI((s) => s.setAgentPopup)
  const navigate = useUI((s) => s.navigate)
  const toast = useUI((s) => s.toast)
  const browse = useBrowseMode((s) => s.browse)

  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 同一个编辑器实例，作为 state 供工具栏订阅 */
  const [view, setView] = useState<EditorView | null>(null)
  const saverRef = useRef<Autosaver | null>(null)
  const loadedFor = useRef<{ id: string; version: number } | null>(null)
  const headingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRef = useRef<TitleHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const reading = useReadingPosition(scrollRef, viewRef)
  /** 组字期间推迟套用的服务器版本（base 已固定为推迟时的编辑器内容或共同祖先） */
  const deferred = useRef<{ base: string; next: string }[]>([])

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
    return closeAppearancePanel
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
      upload: uploadImage,
      onUploadError: (err) => toast({ message: `图片上传失败：${errorMessage(err)}`, tone: 'error' }),
      onDocChange: (content) => {
        saverRef.current?.change(content)
        if (headingTimer.current) clearTimeout(headingTimer.current)
        headingTimer.current = setTimeout(() => useEditor.getState().setHeadings(extractHeadings(content)), 300)
      },
      onSave: () => void saverRef.current?.flush(),
      onAppearance: (a, animate) => useNoteAppearance.getState().publish(a, animate),
    }
    const extensions = editorExtensions(env)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: '', extensions: [extensions, browseCompartment.of(browseExtension(useBrowseMode.getState().browse))] }),
    })
    viewRef.current = view
    setView(view)
    editorRef.view = view
    editorRef.extensions = extensions

    // 服务器版本套进编辑器；编辑器有本地修改时变基并重新保存
    const apply = (base: string | null, next: string) => {
      if (applyRemoteTo(view, base, next)) saverRef.current?.change(view.state.doc.toString())
      useEditor.getState().setHeadings(extractHeadings(view.state.doc.toString()))
    }
    const flushDeferred = () => {
      if (view.composing) return
      const list = deferred.current
      deferred.current = []
      for (const d of list) apply(d.base, d.next)
    }
    const onCompositionEnd = () => setTimeout(flushDeferred, 0)
    view.contentDOM.addEventListener('compositionend', onCompositionEnd)
    const bridge = {
      applyRemote: (noteId: string, base: string | null, next: string) => {
        if (loadedFor.current?.id !== noteId) return
        // 正在用输入法组字：推迟到组字结束，避免打断输入
        if (view.composing) deferred.current.push({ base: base ?? view.state.doc.toString(), next })
        else apply(base, next)
      },
      isDirty: () => saverRef.current?.dirty ?? false,
      saveSoon: () => saverRef.current?.kick(),
      discardPending: () => saverRef.current?.reset() ?? null,
      flush: () => saverRef.current?.flush() ?? Promise.resolve(),
    }
    editorBridge.current = bridge

    return () => {
      view.contentDOM.removeEventListener('compositionend', onCompositionEnd)
      if (editorBridge.current === bridge) editorBridge.current = null
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
      applyRemoteTo(view, null, doc.content)
    } else {
      // 切换笔记：先记下上一篇的浏览位置，再保存它的内容
      reading.flush()
      const old = saverRef.current
      if (old) {
        void old.flush().finally(() => old.dispose())
      }
      deferred.current = []
      const noteId = id
      saverRef.current = new Autosaver({
        delay: SAVE_DELAY,
        // 组字期间推迟套用的服务器版本也要并进要保存的内容，否则会被当成本地删除
        save: async (content) => {
          for (const d of deferred.current) content = rebase(d.base, d.next, content)
          await useEditor.getState().save(noteId, content)
        },
        onStatus: (s, err) => {
          if (useEditor.getState().noteId === noteId) useEditor.getState().setStatus(s, err)
        },
        isComposing: () => viewRef.current?.composing ?? false,
      })
      // 每篇笔记打开时按“打开笔记默认浏览”设置重置浏览模式
      const startBrowse = useEditorPrefs.getState().browseByDefault
      useBrowseMode.getState().setBrowse(startBrowse)
      // 光标放在正文开头：front matter 里只有外观设置时它是藏起来的（cm/appearance）
      view.setState(
        EditorState.create({
          doc: doc.content,
          selection: { anchor: bodyStart(doc.content) },
          extensions: [editorRef.extensions, browseCompartment.of(browseExtension(startBrowse))],
        }),
      )
      // 回到上次的浏览位置（滚动 + 光标，见 useReadingPosition）；新建的笔记没有记录，从顶部开始
      reading.restore(id)
      if (takeTitleFocus(id)) {
        if (!startBrowse) {
          titleRef.current?.focus()
        }
      } else if (!mobile && !startBrowse) {
        view.focus()
      }
    }
    loadedFor.current = { id, version: docVersion }
    useEditor.getState().setHeadings(extractHeadings(doc.content))
  }, [doc, docVersion, id, mobile])

  // 切换浏览 / 编辑：原地 reconfigure，文档、光标和滚动位置都不变
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || view.state.readOnly === browse) return
    view.dispatch({ effects: browseCompartment.reconfigure(browseExtension(browse)) })
    if (browse) {
      // 收起键盘（手机）并关掉会改写 front matter 的外观面板
      view.contentDOM.blur()
      closeAppearancePanel()
    }
  }, [browse])

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

  const showToolbar = useEditorPrefs((s) => s.formatToolbar)
  const pageWidth = useNoteAppearance((s) => s.width)
  const noteFont = useNoteAppearance((s) => s.font)
  const tocRail = useEditorPrefs((s) => s.tocRail)
  const animateWidth = useNoteAppearance((s) => s.animate)
  const showEditor = !!doc && doc.id === id && !notFound

  return (
    <section className="editor-pane" aria-label="编辑器">
      <header className="editor-bar">
        {mobile ? (
          <IconButton label="返回" onClick={() => navigate({ view: 'home' })}>
            <ArrowLeft size={20} />
          </IconButton>
        ) : (
          // 桌面端的侧栏、右栏收起按钮浮在三栏之上，收起后停在标题栏两角，这里给它们让位（见 shell/PanelToggle）
          <PanelToggleSlot side="left" />
        )}
        {note && showEditor ? (
          <TitleInput
            ref={titleRef}
            path={dirname(note.path)}
            title={note.title}
            readOnly={browse}
            mobile={mobile}
            onCommit={(v) => renameNote(note, v)}
            onEnter={() => viewRef.current?.focus()}
          />
        ) : (
          <div className="editor-heading" />
        )}
        <span className="spacer" />
        <SaveIndicator status={status} error={error} onRetry={() => void saverRef.current?.flush()} />
        {note && (
          <IconButton label="仅浏览" active={browse} onClick={() => useBrowseMode.getState().toggle()} data-testid="browse-toggle">
            <Eye size={18} />
          </IconButton>
        )}
        <IconButton label="助手" active={agentPopup} onClick={() => setAgentPopup(!agentPopup)} data-testid="open-agent-popup">
          <Sparkles size={18} />
        </IconButton>
        {mobile && (
          <IconButton label={rightOpen ? '隐藏右栏' : '显示右栏'} active={rightOpen} onClick={() => toggleRight()}>
            <PanelRight size={18} />
          </IconButton>
        )}
        {note && (
          <IconButton
            label="更多操作"
            onClick={(e) => {
              const anchor = e.currentTarget
              openMenu(anchor, [
                {
                  label: browse ? '切换到编辑' : '切换到仅浏览',
                  icon: <Eye size={16} />,
                  run: () => useBrowseMode.getState().toggle(),
                },
                // 浏览模式下不提供会改动笔记内容（标题、front matter 里的外观设置）的入口
                ...(browse
                  ? []
                  : [
                      {
                        label: '重命名',
                        icon: <Pencil size={16} />,
                        run: () => {
                          titleRef.current?.focus()
                        },
                      },
                      { label: '外观和布局', icon: <CaseSensitive size={16} />, submenu: true, run: () => openAppearancePanel(anchor) },
                    ]),
                'separator',
                { label: '移到回收站', icon: <Trash size={16} />, danger: true, run: () => void deleteNote(note) },
              ])
            }}
          >
            <Ellipsis size={18} />
          </IconButton>
        )}
        {!mobile && <PanelToggleSlot side="right" />}
      </header>

      {!mobile && showToolbar && view && showEditor && !browse && (
        <FormatToolbar
          view={view}
          upload={uploadImage}
          onUploadError={(err) => toast({ message: `图片上传失败：${errorMessage(err)}`, tone: 'error' })}
        />
      )}

      {/* 页宽只在桌面端生效（editor.css）；切换时过渡，载入笔记时直接到位 */}
      <div className="editor-scroll" ref={scrollRef} data-width={pageWidth} data-font={noteFont} data-animate={animateWidth ? '' : undefined}>
        {!mobile && tocRail && showEditor && <TocRail view={view} scrollRef={scrollRef} />}
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
      <AppearancePanelHost mobile={mobile} />
      {mobile && (
        <MobileToolbar
          view={browse ? null : view}
          upload={uploadImage}
          onUploadError={(err) => toast({ message: `图片上传失败：${errorMessage(err)}`, tone: 'error' })}
        />
      )}
    </section>
  )
}

async function uploadImage(file: File): Promise<string> {
  const res = await sync.uploadAttachment(file, file.name && file.name !== 'image.png' ? file.name : undefined)
  return res.path
}

/**
 * 把服务器版本 next 套到编辑器上：按行 diff 生成最小改动，光标和滚动位置随改动映射。
 * base 是 next 与编辑器内容的共同祖先（null 表示就是编辑器当前内容）；编辑器在 base 之后
 * 还有修改时，把服务器的改动映射到本地修改之后再套用（变基），返回 true 表示结果需要重新保存。
 * 来自服务器的改动不进撤销历史。
 */
function applyRemoteTo(view: EditorView, base: string | null, next: string): boolean {
  const cur = view.state.doc.toString()
  const from = base ?? cur
  const theirs = diffChangeSet(from, next)
  const changes = from === cur ? theirs : theirs.map(diffChangeSet(from, cur))
  if (!changes.empty) view.dispatch({ changes, annotations: [remoteSync.of(true), Transaction.addToHistory.of(false)] })
  return from !== cur
}

/**
 * 保存状态：状态切换时旧文字向上淡出、新文字自下淡入（弹簧）；reduced motion 时只淡入淡出。
 * aria-live 放在不变的外层上，读屏只播报新状态。
 */
function SaveIndicator({ status, error, onRetry }: { status: keyof typeof STATUS_TEXT; error: string | null; onRetry: () => void }) {
  const reduced = useReducedMotion()
  const dy = reduced ? 0 : 6
  const motionProps = {
    initial: { opacity: 0, y: dy },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -dy },
    transition: { ...springDefault, opacity: fadeTransition },
  }
  return (
    <span className="save-slot" aria-live="polite" data-testid="save-status">
      <AnimatePresence initial={false} mode="popLayout">
        {status === 'error' ? (
          <motion.button key="error" className="save-status is-error" onClick={onRetry} title={error ?? undefined} {...motionProps}>
            {STATUS_TEXT.error}
            {error ? `：${error}` : ''} · 重试
          </motion.button>
        ) : status !== 'idle' ? (
          <motion.span key={status} className={`save-status is-${status}`} {...motionProps}>
            {STATUS_TEXT[status]}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  )
}

interface TitleProps {
  /** 文件夹路径（不含标题），空串表示根目录 */
  path: string
  title: string
  /** 浏览模式下只读 */
  readOnly: boolean
  mobile: boolean
  onCommit: (v: string) => Promise<boolean>
  onEnter: () => void
}

export interface TitleHandle {
  /** 进入改名状态并全选（浏览模式下无效） */
  focus: () => void
}

/**
 * 顶栏左侧的“路径 / 标题”：平时标题是按钮，点击（或键盘回车）原地变成输入框；
 * 回车或失焦提交，Esc 取消。窄宽度下先截断路径，再截断标题（editor.css）。
 */
const TitleInput = forwardRef<TitleHandle, TitleProps>(function TitleInput({ path, title, readOnly, mobile, onCommit, onEnter }, ref) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const committing = useRef(false)
  const finished = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const start = () => {
    if (readOnly) return
    finished.current = false
    setValue(title)
    setEditing(true)
  }
  useImperativeHandle(ref, () => ({ focus: start }))
  // 进入编辑后聚焦并全选；浏览模式开启时放弃编辑
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])
  useEffect(() => {
    if (readOnly) setEditing(false)
  }, [readOnly])
  const finish = () => {
    finished.current = true
    setEditing(false)
  }
  const commit = async () => {
    if (committing.current || finished.current) return
    const v = value.trim()
    finish()
    if (!v || v === title) return
    committing.current = true
    await onCommit(v)
    committing.current = false
  }
  const showPath = !mobile && path
  return (
    <div className={`editor-heading${editing ? ' is-editing' : ''}`} title={path ? `${path} / ${title}` : title}>
      {showPath && (
        <span className="editor-crumb" data-testid="note-path">
          {path.split('/').join(' / ')}
          <span className="editor-crumb-sep" aria-hidden="true">
            {' / '}
          </span>
        </span>
      )}
      {editing ? (
        <input
          ref={inputRef}
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
              e.preventDefault()
              finish()
              onEnter()
            }
          }}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className="editor-title"
          data-testid="note-title"
          aria-label={readOnly ? `笔记标题：${title}` : `笔记标题：${title}，点击重命名`}
          aria-disabled={readOnly || undefined}
          onClick={start}
        >
          {title}
        </button>
      )}
    </div>
  )
})

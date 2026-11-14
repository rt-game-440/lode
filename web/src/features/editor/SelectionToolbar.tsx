import { startCompletion } from '@codemirror/autocomplete'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import {
  Bold,
  Brackets,
  Code,
  Copy,
  Ellipsis,
  Italic,
  Languages,
  Lightbulb,
  Link,
  Link2,
  ListCollapse,
  MessageCircleQuestion,
  PenLine,
  Sparkles,
  TextQuote,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { usePop } from '../../components/usePop'
import { copyText } from '../../lib/clipboard'
import { onViewportChange } from '../../lib/viewport'
import { linkTextFor } from '../../lib/wikilink'
import { enabledModels, useAgent } from '../../stores/agent'
import { useAgentDraft } from '../../stores/agentDraft'
import { useEditorPrefs } from '../../stores/editorPrefs'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { fadeOutQuick, springSnappy } from '../../styles/tokens/motion'
import { FORMAT_ACTIONS, type FormatId } from './cm/formatActions'
import { onEditorUpdate } from './cm/selectionEvents'
import { remoteSync } from './cm/setup'
import { type Box, type Placement, type SelectionGeometry, placeToolbar, selectionVisible } from './selectionLayout'
import './selection-toolbar.css'

/** 与选区的距离：上方 8px；手机放在下方时让出系统的选区拖柄 */
const GAP = 8
const HANDLE_CLEARANCE = 28
const MARGIN = 8
/** 触摸选区（拖柄调整）停下多久之后出现 */
const TOUCH_SETTLE_MS = 350

const ICONS: Partial<Record<FormatId, ReactNode>> = {
  bold: <Bold size={16} />,
  italic: <Italic size={16} />,
  code: <Code size={16} />,
  link: <Link size={16} />,
  wikilink: <Brackets size={16} />,
  quote: <TextQuote size={16} />,
}
/** 悬浮框里的格式按钮：行内格式和链接，加上引用；标题、列表这类整行格式留给顶栏和手机工具栏 */
const DESKTOP_FORMATS: FormatId[] = ['bold', 'italic', 'code', 'link', 'wikilink', 'quote']
/** 手机宽度放不下全部按钮：这几个直接显示，引用、笔记链接和“复制为链接”收进“更多” */
const MOBILE_FORMATS: FormatId[] = ['bold', 'italic', 'code', 'link']
const MOBILE_MORE: FormatId[] = ['quote', 'wikilink']
/** 执行后紧接着要输入（链接地址、笔记名）：收起工具框 */
const TYPING_NEXT = new Set<FormatId>(['link', 'wikilink'])

/** 问助手的快捷指令：填进输入框，用户可以再改，回车发送 */
const ASK_PROMPTS: { id: string; label: string; icon: ReactNode; prompt: string }[] = [
  { id: 'explain', label: '解释', icon: <Lightbulb size={16} />, prompt: '解释一下引用的这段文字。' },
  {
    id: 'rewrite',
    label: '改写',
    icon: <PenLine size={16} />,
    prompt: '改写引用的这段文字，让它更通顺清楚，意思不变；改好后替换当前笔记里的这段原文。',
  },
  { id: 'translate', label: '翻译', icon: <Languages size={16} />, prompt: '翻译引用的这段文字：中文译成英文，其他语言译成中文。' },
  { id: 'summarize', label: '总结', icon: <ListCollapse size={16} />, prompt: '用几句话总结引用的这段文字的要点。' },
]

interface Snapshot {
  text: string
  from: number
  to: number
}

function snapshotOf(view: EditorView): Snapshot | null {
  const sel = view.state.selection
  const ranges = sel.ranges.filter((r) => !r.empty)
  if (!ranges.length) return null
  const main = sel.main.empty ? ranges[0] : sel.main
  return { text: ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join('\n'), from: main.from, to: main.to }
}

/** 选区首尾所在行的矩形；选区不在渲染范围内时用渲染范围的边缘代替。 */
function geometryOf(view: EditorView, from: number, to: number): SelectionGeometry | null {
  const vp = view.viewport
  const a = view.coordsAtPos(Math.max(from, vp.from), 1)
  const b = view.coordsAtPos(Math.min(to, vp.to), -1)
  if (!a || !b) return null
  return { start: { left: a.left, top: a.top, bottom: a.bottom }, end: { right: b.right, top: b.top, bottom: b.bottom } }
}

/** 工具框能用的区域：编辑区滚动容器的可见部分，再与可视区域（键盘以上）取交集。 */
function boundsOf(view: EditorView): { visible: Box; bounds: Box } {
  const scroller = view.dom.closest('.editor-scroll') ?? view.scrollDOM
  const r = scroller.getBoundingClientRect()
  const vv = window.visualViewport
  const vvTop = vv ? vv.offsetTop : 0
  const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
  const visible = { left: r.left, top: Math.max(r.top, vvTop), right: r.right, bottom: Math.min(r.bottom, vvBottom) }
  let bottom = visible.bottom
  // 手机编辑工具栏在编辑区下方（外壳贴合可视区域）；动画进行中时它可能还压在编辑区上
  const mt = document.querySelector('.mobile-toolbar')
  if (mt) bottom = Math.min(bottom, mt.getBoundingClientRect().top)
  return { visible, bounds: { ...visible, top: visible.top + MARGIN / 2, bottom: bottom - MARGIN / 2 } }
}

/**
 * 选中文字后在选区附近浮出的工具框（#73）：格式、问助手、复制。
 * - 鼠标拖选、键盘 Shift+方向键选出非空选区，松手（松键）后出现；触摸选区停下片刻后出现；
 * - 选区为空、开始输入（文档有了不是工具框自己发出的改动，输入法组字也算）、Esc、点框外时消失；滚出可见区域时隐藏，滚回来再出现；
 * - 桌面默认在选区上方、放不下时翻到下方；手机放在下方（上方留给系统的选区菜单），让出拖柄；
 * - 仅浏览模式只显示“问助手”和复制；
 * - role="toolbar"，Alt+F10 从正文进入，←→ 在按钮间移动，Esc 回到正文。
 */
export function SelectionToolbar({ view, mobile, browse, noteId }: { view: EditorView | null; mobile: boolean; browse: boolean; noteId: string }) {
  const enabled = useEditorPrefs((s) => s.selectionToolbar)
  if (!view || !enabled) return null
  return <SelectionToolbarInner view={view} mobile={mobile} browse={browse} noteId={noteId} />
}

function SelectionToolbarInner({ view, mobile, browse, noteId }: { view: EditorView; mobile: boolean; browse: boolean; noteId: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Placement | null>(null)
  /** 选区滚出可见区域：先收起，滚回来再出现 */
  const [offscreen, setOffscreen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)
  const size = useRef<{ width: number; height: number } | null>(null)
  /** 鼠标在正文里按下（拖选中） */
  const dragging = useRef(false)
  /** 被 Esc、点框外、输入收起的选区：同一个选区不再自动出现 */
  const dismissed = useRef<string | null>(null)
  /** 工具框自己发出的改动（格式命令）不算“开始输入” */
  const self = useRef(false)
  /** 在工具框上按下时的选区：手机上点按钮可能让系统先清掉选区 */
  const pressed = useRef<Snapshot | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 键盘还按着（Shift+方向键选到一半）：松键后再出现 */
  const keyHeld = useRef(false)
  const frame = useRef(0)
  const config = useAgent((s) => s.config)
  const noModels = config !== null && enabledModels(config).length === 0

  const popAbove = usePop({ scale: 0.96, y: 4 }, { scale: 0.98 }, { transition: fadeOutQuick })
  const popBelow = usePop({ scale: 0.96, y: -4 }, { scale: 0.98 }, { transition: fadeOutQuick })

  const reposition = useCallback(() => {
    if (!openRef.current) return
    const snap = snapshotOf(view)
    const g = snap && geometryOf(view, snap.from, snap.to)
    if (!snap || !g) {
      setOffscreen(true)
      return
    }
    const { visible, bounds } = boundsOf(view)
    if (!selectionVisible(g, visible)) {
      setOffscreen(true)
      return
    }
    setOffscreen(false)
    const el = root.current
    if (el) size.current = { width: el.offsetWidth, height: el.offsetHeight }
    // 第一次显示时还没量到尺寸：先不可见地渲染一帧，布局后再定位
    if (!size.current) return
    setPos(
      placeToolbar(g, {
        size: size.current,
        bounds,
        prefer: mobile ? 'below' : 'above',
        gapAbove: GAP,
        gapBelow: mobile ? HANDLE_CLEARANCE : GAP,
        margin: MARGIN,
      }),
    )
  }, [view, mobile])

  const schedule = useCallback(() => {
    if (frame.current || !openRef.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      reposition()
    })
  }, [reposition])

  const hide = useCallback((dismiss: boolean) => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = null
    if (dismiss) {
      const s = snapshotOf(view)
      dismissed.current = s ? `${s.from}:${s.to}` : null
    }
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
  }, [view])

  /** 有非空选区、没在拖选、没被收起过时出现 */
  const tryShow = useCallback(() => {
    if (dragging.current) return
    const s = snapshotOf(view)
    if (!s || dismissed.current === `${s.from}:${s.to}`) return
    if (!openRef.current) {
      openRef.current = true
      setPos(null)
      setOpen(true)
      // 第一次出现时才载入助手配置（判断有没有可用模型）
      if (useAgent.getState().config === null) void useAgent.getState().loadConfig()
    } else schedule()
  }, [view, schedule])

  // 切换浏览 / 编辑后按钮变了：重新量尺寸
  useLayoutEffect(() => {
    size.current = null
    if (openRef.current) reposition()
  }, [browse, reposition])

  // 刚出现（不可见的一帧）或从滚出区域回来：量尺寸并定位
  useLayoutEffect(() => {
    if (open && !pos) reposition()
  }, [open, pos, offscreen, reposition])

  // 编辑器状态：选区、改动、几何变化
  useEffect(() => {
    const offUpdate = onEditorUpdate(view, (u: ViewUpdate) => {
      const typed = u.docChanged && !self.current && u.transactions.some((tr) => tr.docChanged && !tr.annotation(remoteSync))
      const empty = u.state.selection.ranges.every((r) => r.empty)
      if (typed) {
        hide(true)
        return
      }
      if (u.selectionSet) {
        if (empty) {
          // 正在点工具框里的按钮（手机上系统可能先清掉选区）：等按钮执行完再说
          if (!pressed.current) {
            dismissed.current = null
            hide(false)
          }
          return
        }
        if (self.current) {
          schedule()
          return
        }
        if (openRef.current) {
          schedule()
          return
        }
        // 鼠标拖选等松手、键盘等松键；其余（触摸拖柄、程序设置）停下片刻后出现
        if (!dragging.current && !keyHeld.current) {
          if (settle.current) clearTimeout(settle.current)
          settle.current = setTimeout(tryShow, TOUCH_SETTLE_MS)
        }
        return
      }
      if (u.geometryChanged || u.viewportChanged || u.docChanged) schedule()
      if (u.focusChanged && !u.view.hasFocus && !browse) {
        // 焦点进了工具框或它打开的菜单时保留
        requestAnimationFrame(() => {
          const a = document.activeElement
          if (a && (root.current?.contains(a) || a.closest('.menu'))) return
          if (a && a !== document.body) hide(false)
        })
      }
    })
    return offUpdate
  }, [view, hide, schedule, tryShow, browse])

  // DOM 事件：按下、松开、按键、输入法、滚动、点框外
  useEffect(() => {
    const content = view.contentDOM
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      dragging.current = true
      dismissed.current = null
      hide(false)
    }
    const onUp = () => {
      // 在工具框上按下时记下的选区，留到随后的 click 用完
      if (pressed.current) setTimeout(() => (pressed.current = null), 0)
      if (!dragging.current) return
      dragging.current = false
      // CodeMirror 在 mouseup 之后才定下选区
      requestAnimationFrame(tryShow)
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current) {
        e.preventDefault()
        e.stopPropagation()
        hide(true)
        return
      }
      if (e.key === 'F10' && e.altKey && openRef.current) {
        e.preventDefault()
        focusButton(root.current, 0)
        return
      }
      keyHeld.current = true
    }
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
        // 还按着修饰键（Shift+方向键选到一半）
        if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Alt') return
      }
      keyHeld.current = false
      if (e.key === 'Escape') return
      tryShow()
    }
    const onOutside = (e: PointerEvent) => {
      if (!openRef.current) return
      const t = e.target as Element | null
      if (!t || root.current?.contains(t) || view.dom.contains(t) || t.closest?.('.menu')) return
      hide(true)
    }
    const onScroll = () => schedule()
    view.dom.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    content.addEventListener('keydown', onKeyDown)
    content.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    const offVV = onViewportChange(onScroll)
    return () => {
      view.dom.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      content.removeEventListener('keydown', onKeyDown)
      content.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      offVV()
    }
  }, [view, hide, schedule, tryShow])

  // 浏览模式下正文不可聚焦：Alt+F10 / Esc 在窗口上接
  useEffect(() => {
    if (!browse) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!openRef.current) return
      if (e.key === 'F10' && e.altKey) {
        e.preventDefault()
        focusButton(root.current, 0)
      } else if (e.key === 'Escape' && !root.current?.contains(document.activeElement)) {
        e.preventDefault()
        hide(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [browse, hide])

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current)
      if (frame.current) cancelAnimationFrame(frame.current)
    },
    [],
  )

  /* ---------- 按钮动作 ---------- */

  const current = (): Snapshot | null => {
    const p = pressed.current
    pressed.current = null
    return snapshotOf(view) ?? p
  }

  const backToText = () => {
    if (!browse) view.focus()
  }

  const runFormat = (id: FormatId) => {
    const a = FORMAT_ACTIONS.find((x) => x.id === id)
    if (!a || browse) return
    pressed.current = null
    self.current = true
    try {
      view.dispatch(a.run(view.state))
    } finally {
      self.current = false
    }
    view.focus()
    if (TYPING_NEXT.has(id)) {
      hide(true)
      if (id === 'wikilink') startCompletion(view)
    } else schedule()
  }

  const copy = async (asLink: boolean) => {
    const snap = current()
    let text = snap?.text ?? ''
    if (asLink) {
      const notes = useVault.getState().notes
      const note = notes[noteId]
      if (!note) return
      text = `[[${linkTextFor(note.path, Object.values(notes).map((n) => n.path))}]]`
    }
    if (!text) return
    const ok = await copyText(text)
    useUI.getState().toast(ok ? { message: asLink ? `已复制链接 ${text}` : '已复制', tone: 'success' } : { message: '复制失败', tone: 'error' })
    hide(true)
    backToText()
  }

  const ask = (prompt: string | null) => {
    const snap = current()
    if (!snap) return
    const draft = useAgentDraft.getState()
    draft.setQuote(snap.text)
    if (prompt !== null) draft.setText(prompt)
    hide(true)
    const ui = useUI.getState()
    if (!ui.agentPopup) ui.setAgentPopup(true)
    else if (!mobile) {
      // 弹窗已经开着：把焦点放进输入框（新打开的由弹窗自己聚焦）
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="agent-popup"] [data-testid="agent-input"]')?.focus())
    }
  }

  const onAsk = (anchor: HTMLElement) => {
    if (noModels) {
      useUI.getState().toast({
        message: '还没有可用的模型，先在设置的“助手”里添加',
        action: { label: '打开设置', run: () => useUI.getState().navigate({ view: 'settings', sub: ['agent'] }) },
      })
      return
    }
    // 打开菜单会让正文失焦：先记下选区
    pressed.current = snapshotOf(view) ?? pressed.current
    const keep = pressed.current
    openMenu(anchor, [
      ...ASK_PROMPTS.map((p) => ({
        label: p.label,
        icon: p.icon,
        run: () => {
          pressed.current = keep
          ask(p.prompt)
        },
      })),
      'separator',
      {
        label: '直接提问…',
        icon: <MessageCircleQuestion size={16} />,
        run: () => {
          pressed.current = keep
          ask(null)
        },
      },
    ])
  }

  const onMore = (anchor: HTMLElement) => {
    pressed.current = snapshotOf(view) ?? pressed.current
    const keep = pressed.current
    const items: MenuEntry[] = MOBILE_MORE.map((id) => {
      const a = FORMAT_ACTIONS.find((x) => x.id === id)!
      return { label: a.label, icon: ICONS[id], run: () => runFormat(id) }
    })
    items.push('separator', {
      label: '复制为链接',
      icon: <Link2 size={16} />,
      run: () => {
        pressed.current = keep
        void copy(true)
      },
    })
    openMenu(anchor, items)
  }

  /* ---------- 键盘：方向键在按钮间移动 ---------- */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = toolbarButtons(root.current)
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
      focusButton(root.current, next)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusButton(root.current, e.key === 'Home' ? 0 : buttons.length - 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      hide(true)
      backToText()
    }
  }

  const formats = browse ? [] : mobile ? MOBILE_FORMATS : DESKTOP_FORMATS
  const visible = open && !offscreen
  const pop = pos?.placement === 'below' ? popBelow : popAbove

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={root}
          role="toolbar"
          aria-label="选中文字"
          aria-orientation="horizontal"
          className={`selection-toolbar${mobile ? ' is-mobile' : ''}`}
          data-testid="selection-toolbar"
          data-placement={pos?.placement}
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? 'visible' : 'hidden',
            transformOrigin: pos ? `${pos.originX}px ${pos.placement === 'above' ? '100%' : '0'}` : undefined,
          }}
          {...pop}
          transition={springSnappy}
          onKeyDown={onKeyDown}
          // 不抢正文焦点、不让系统清掉选区（手机上键盘也不收起）
          onPointerDown={(e) => {
            pressed.current = snapshotOf(view) ?? pressed.current
            e.preventDefault()
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <ToolButton
            label="问助手"
            title={noModels ? '还没有可用的模型，先在设置的“助手”里添加' : '问助手：解释、改写、翻译、总结'}
            disabled={noModels}
            wide={!mobile}
            first
            haspopup
            onPress={(el) => onAsk(el)}
            testId="selection-ask"
          >
            <Sparkles size={16} />
            {!mobile && <span className="selection-toolbar-text">问助手</span>}
          </ToolButton>
          {formats.length > 0 && <span className="selection-toolbar-sep" aria-hidden="true" />}
          {formats.map((id) => {
            const a = FORMAT_ACTIONS.find((x) => x.id === id)!
            return (
              <ToolButton key={id} label={a.label} title={`${a.label}（${a.shortcut}）`} onPress={() => runFormat(id)} testId={`selection-${id}`}>
                {ICONS[id]}
              </ToolButton>
            )
          })}
          <span className="selection-toolbar-sep" aria-hidden="true" />
          <ToolButton label="复制" title="复制选中的文字" onPress={() => void copy(false)} testId="selection-copy">
            <Copy size={16} />
          </ToolButton>
          {mobile && !browse ? (
            <ToolButton label="更多" title="更多：引用、笔记链接、复制为链接" haspopup onPress={(el) => onMore(el)} testId="selection-more">
              <Ellipsis size={16} />
            </ToolButton>
          ) : (
            <ToolButton label="复制为链接" title="复制指向这篇笔记的 [[链接]]" onPress={() => void copy(true)} testId="selection-copy-link">
              <Link2 size={16} />
            </ToolButton>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function toolbarButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
}

/** 漫游焦点：只有当前按钮在 Tab 序列里 */
function focusButton(root: HTMLElement | null, index: number) {
  const buttons = toolbarButtons(root)
  buttons.forEach((b, i) => (b.tabIndex = i === index ? 0 : -1))
  buttons[index]?.focus()
}

function ToolButton({
  label,
  title,
  onPress,
  children,
  disabled,
  wide,
  first,
  haspopup,
  testId,
}: {
  label: string
  title: string
  onPress: (el: HTMLButtonElement) => void
  children: ReactNode
  disabled?: boolean
  wide?: boolean
  first?: boolean
  haspopup?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      className={`selection-toolbar-btn${wide ? ' is-wide' : ''}${disabled ? ' is-disabled' : ''}`}
      aria-label={label}
      title={title}
      // 置灰但仍可聚焦、可点：点了提示去设置
      aria-disabled={disabled || undefined}
      aria-haspopup={haspopup && !disabled ? 'menu' : undefined}
      tabIndex={first ? 0 : -1}
      data-testid={testId}
      onClick={(e) => onPress(e.currentTarget)}
    >
      {children}
    </button>
  )
}

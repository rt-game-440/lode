import { EditorView } from '@codemirror/view'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePop } from '../../components/usePop'
import { type Heading, useEditor } from '../../stores/editor'
import { fadeOutQuick, springScroll, springSnappy } from '../../styles/tokens/motion'
import './toc-rail.css'

/**
 * 正文右侧的目录条（#47，桌面端）：一列细横线，每条对应一个标题，缩进和长短表示层级，当前阅读位置的那条加深。
 * 悬停（短暂延迟）或键盘聚焦时在原位浮出完整目录卡片，点击平滑滚动到标题；滚动正文时当前项跟随。
 * 放在滚动容器开头的一个高度为 0 的 sticky 元素里，始终贴着编辑区右上角，位于正文列外侧的留白中。
 */

/** 悬停多久后展开、离开多久后收起（毫秒），避免鼠标划过时误触 */
const OPEN_DELAY = 120
const CLOSE_DELAY = 220
/** 标题越过滚动区顶部以下这个比例的位置时算“正在阅读” */
const READ_LINE = 0.3

interface Props {
  view: EditorView | null
  scrollRef: RefObject<HTMLDivElement | null>
}

export function TocRail({ view, scrollRef }: Props) {
  const headings = useEditor((s) => s.headings)
  const reduced = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [maxH, setMaxH] = useState<number | null>(null)
  const wrap = useRef<HTMLElement>(null)
  const railBtn = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 点击目录项后的程序滚动期间，高亮固定在目标上，不随途经的标题跳动 */
  const pinned = useRef<number | null>(null)
  /** Esc 收起后把焦点还给目录条时，不要因为聚焦又展开 */
  const escaped = useRef(false)
  const pop = usePop({ scale: 0.96 }, { scale: 0.98 }, { transition: fadeOutQuick })

  const min = headings.length ? Math.min(...headings.map((h) => h.level)) : 1

  /** 标题顶部在窗口里的纵坐标；视口外的行用编辑器的高度估算 */
  const headingY = useCallback(
    (h: Heading) => {
      if (!view) return 0
      const line = view.state.doc.line(Math.min(Math.max(1, h.line), view.state.doc.lines))
      return view.lineBlockAt(line.from).top + view.documentTop
    },
    [view],
  )

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el || !view || !headings.length) return
    setMaxH(el.clientHeight)
    if (pinned.current !== null) return setActive(pinned.current)
    const top = el.getBoundingClientRect().top
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    const line = top + el.clientHeight * (atEnd ? 1 : READ_LINE)
    let cur = 0
    headings.forEach((h, i) => {
      if (headingY(h) <= line) cur = i
    })
    setActive(cur)
  }, [headingY, headings, scrollRef, view])

  // 滚动、正文高度变化、窗口尺寸变化时重新计算当前项
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !view) return
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    schedule()
    el.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const ro = new ResizeObserver(schedule)
    ro.observe(view.contentDOM)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      ro.disconnect()
    }
  }, [measure, scrollRef, view])

  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(() => setOpen(next), delay)
  }

  // 展开时把当前项滚进卡片可见范围
  useLayoutEffect(() => {
    if (open) card.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' })
  }, [open])

  /** 正在进行的跳转动画，用户自己滚动或再次跳转时停掉 */
  const jump = useRef<{ stop: () => void } | null>(null)
  useEffect(() => () => jump.current?.stop(), [])

  const go = (i: number) => {
    const el = scrollRef.current
    const h = headings[i]
    if (!el || !h || !view) return
    jump.current?.stop()
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const target = () => el.scrollTop + headingY(h) - el.getBoundingClientRect().top - rem
    pinned.current = i
    setActive(i)
    // 收尾：交给编辑器按实测行高把标题对齐到顶部，再恢复跟随滚动的高亮
    const finish = () => {
      jump.current = null
      const line = view.state.doc.line(Math.min(Math.max(1, h.line), view.state.doc.lines))
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: rem }) })
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          pinned.current = null
          measure()
        }),
      )
    }
    if (reduced) {
      el.scrollTop = target()
      return finish()
    }
    // 不用浏览器原生的平滑滚动：编辑器边滚边实测行高、校正滚动位置，会把原生动画打断。
    // 这里每帧按最新的估算重新算终点，用弹簧推进比例，终点随实测逐步变准。
    const from = el.scrollTop
    const controls = animate(0, 1, {
      ...springScroll,
      onUpdate: (t) => {
        el.scrollTop = from + (target() - from) * t
      },
      onComplete: finish,
    })
    // 用户自己滚动、按键时立即停下，把控制权交还
    const cancel = () => stop()
    const stop = () => {
      controls.stop()
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('pointerdown', cancel)
      el.removeEventListener('keydown', cancel)
      jump.current = null
      pinned.current = null
    }
    el.addEventListener('wheel', cancel, { passive: true, once: true })
    el.addEventListener('pointerdown', cancel, { once: true })
    el.addEventListener('keydown', cancel, { once: true })
    jump.current = { stop }
    controls.then(() => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('pointerdown', cancel)
      el.removeEventListener('keydown', cancel)
    })
  }

  if (!headings.length) return null

  const width = (h: Heading) => Math.max(0, h.level - min)
  const style = { '--toc-max-height': maxH ? `${maxH}px` : undefined, '--toc-count': headings.length } as CSSProperties

  return (
    <div className="toc-anchor">
      <nav
        ref={wrap}
        className="toc"
        aria-label="目录"
        data-testid="toc-rail"
        style={style}
        onPointerEnter={(e) => e.pointerType === 'mouse' && later(true, OPEN_DELAY)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && later(false, CLOSE_DELAY)}
        onFocus={() => {
          clearTimeout(timer.current ?? undefined)
          if (escaped.current) escaped.current = false
          else setOpen(true)
        }}
        onBlur={(e) => {
          if (!wrap.current?.contains(e.relatedTarget as Node)) later(false, 0)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !open) return
          e.stopPropagation()
          setOpen(false)
          escaped.current = true
          railBtn.current?.focus()
          escaped.current = false
        }}
      >
        <button
          ref={railBtn}
          type="button"
          className="toc-rail"
          aria-label="目录"
          aria-expanded={open}
          onClick={() => {
            clearTimeout(timer.current ?? undefined)
            setOpen(true)
          }}
        >
          {headings.map((h, i) => (
            <span key={`${h.line}-${i}`} className={`toc-bar depth-${Math.min(width(h), 3)}${i === active ? ' is-active' : ''}`} />
          ))}
        </button>
        <AnimatePresence>
          {open && (
            <motion.div ref={card} className="toc-card" data-testid="toc-card" {...pop} transition={springSnappy}>
              <ul>
                {headings.map((h, i) => (
                  <li key={`${h.line}-${i}`}>
                    <button
                      type="button"
                      className="toc-item"
                      style={{ paddingLeft: `calc(var(--space-3) + ${width(h)} * var(--space-3))` }}
                      aria-current={i === active ? 'location' : undefined}
                      onClick={() => go(i)}
                    >
                      <span className="toc-item-text">{h.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </div>
  )
}

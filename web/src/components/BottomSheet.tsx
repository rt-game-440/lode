import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { VelocityTracker, clampRubber, consumeTouchMoves, lockAxis } from '../lib/gesture'
import { sheetPoints, sheetTarget } from '../lib/sheet'
import { fadeTransition, springPanel, springSheet } from '../styles/tokens/motion'
import { useFocusTrap } from './Modal'
import './bottom-sheet.css'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** 无障碍名称 */
  label: string
  children: ReactNode
  className?: string
}

type Snap = 'half' | 'full'

/** 拖动手柄的选择器：顶部的抓手，以及面板里标了 data-sheet-drag 的区域（标题栏）。其余区域是内容，纵向滚动。 */
const DRAG = '[data-sheet-drag]'

/**
 * 底部弹出的面板（手机）：从屏幕底部升起，默认半屏，可以向上拖到全屏、向下拖关闭，带遮罩。
 * - 在抓手和标题栏上纵向拖动，面板随手指移动；松手按速度投射落点，吸附到全屏、半屏或关闭（见 lib/sheet）。
 *   往上拉过全屏有阻力。内容区域的纵向拖动留给内容滚动。
 * - 点遮罩、Esc 关闭；打开时焦点移入面板并在面板内循环，关闭后回到打开前的位置。
 * - 面板跟随 visualViewport（--vv-*）：软键盘弹出时贴在键盘上方；输入框获得焦点时自动展开到全屏，给键盘和消息留出空间。
 * - 减弱动态效果时不位移：打开和关闭都是淡入淡出，半屏和全屏之间直接切换。
 */
export function BottomSheet({ open, onClose, label, children, className }: BottomSheetProps) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(open)
  const layer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  /** 面板偏离完全展开位置的距离（px，向下为正）；挂载前取一个足够大的值 */
  const y = useMotionValue(10_000)
  /** 减弱动态效果时的整体不透明度 */
  const fade = useMotionValue(0)
  const snap = useRef<Snap>('half')
  const [snapState, setSnapState] = useState<Snap>('half')
  const heights = useRef({ layer: 0, panel: 0 })
  /** 这次开合由手势松手触发：带动量，用 springSheet；其他方式用 springPanel */
  const flung = useRef(false)

  useFocusTrap(panel, open && present)
  if (open && !present) setPresent(true)

  const pointsNow = () => sheetPoints(heights.current.layer, heights.current.panel)
  const snapY = (s: Snap) => (s === 'full' ? 0 : pointsNow().half)

  const scrimOpacity = useTransform(() => {
    if (reduced) return fade.get()
    const { half, closed } = pointsNow()
    return closed > half ? Math.max(0, Math.min(1, 1 - (y.get() - half) / (closed - half))) : y.get() < closed ? 1 : 0
  })

  const measure = () => {
    heights.current = { layer: layer.current?.offsetHeight ?? 0, panel: panel.current?.offsetHeight ?? 0 }
  }

  // 打开：从底部升到半屏（或淡入）；关闭：降到底部（或淡出）
  useLayoutEffect(() => {
    if (!present) return
    measure()
    const { closed } = pointsNow()
    const finish = () => {
      if (open) return
      setPresent(false)
      y.set(10_000)
      fade.set(0)
    }
    const transition = reduced ? fadeTransition : flung.current ? springSheet : springPanel
    flung.current = false
    if (open) {
      if (y.get() > 9_000) {
        snap.current = 'half'
        setSnapState('half')
        y.set(closed)
      }
      if (reduced) {
        y.set(snapY(snap.current))
        const c = animate(fade, 1, transition)
        return () => c.stop()
      }
      fade.set(1)
      const c = animate(y, snapY(snap.current), transition)
      return () => c.stop()
    }
    if (reduced) {
      const c = animate(fade, 0, { ...transition, onComplete: finish })
      return () => c.stop()
    }
    const c = animate(y, closed, { ...transition, onComplete: finish })
    return () => c.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, present, reduced])

  // 可视区域变化（软键盘、旋转屏幕）：保持当前吸附档位
  useEffect(() => {
    const el = layer.current
    if (!present || !el) return
    const ro = new ResizeObserver(() => {
      measure()
      if (open && !y.isAnimating() && !drag.current) y.set(snapY(snap.current))
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // 与 Modal、Drawer 一致：捕获阶段处理，先于页面上其他 Esc 处理
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const goTo = (s: Snap, flungByHand = false) => {
    snap.current = s
    setSnapState(s)
    if (reduced) y.set(snapY(s))
    else animate(y, snapY(s), flungByHand ? springSheet : springPanel)
  }

  // ---- 拖动 ----
  const drag = useRef<{ id: number; y0: number; base: number; axis: 'x' | 'y' | null; v: VelocityTracker } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!open || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (!(e.target instanceof Element) || !e.target.closest(DRAG)) return
    drag.current = { id: e.pointerId, y0: e.clientY, base: y.get(), axis: null, v: new VelocityTracker() }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = drag.current
    if (!s || s.id !== e.pointerId) return
    if (!s.axis) {
      s.axis = lockAxis(0, e.clientY - s.y0)
      if (s.axis !== 'y') return
      // 锁定方向前的防抖距离不计入位移，面板从当前位置开始跟手
      s.y0 = e.clientY
      s.base = y.get()
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const dy = e.clientY - s.y0
    const { closed } = pointsNow()
    if (reduced) {
      s.v.add(dy, e.timeStamp)
      return
    }
    y.set(Math.min(closed, clampRubber(s.base + dy, 0, closed, closed)))
    s.v.add(dy, e.timeStamp)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = drag.current
    drag.current = null
    if (!s || s.axis !== 'y' || s.id !== e.pointerId) return
    const { full, half, closed } = pointsNow()
    const dy = e.clientY - s.y0
    // pointercancel（系统接管了手势）不按速度判断，回到原来的档位
    if (e.type !== 'pointerup') {
      goTo(snap.current)
      return
    }
    // 减弱动态效果时面板不跟手，按拖动距离和速度投射出的落点决定档位
    const from = reduced ? s.base : y.get()
    const to = sheetTarget(reduced ? s.base + dy : from, s.v.velocity(), [full, half, closed])
    if (to === closed) {
      flung.current = true
      onClose()
    } else goTo(to === full ? 'full' : 'half', true)
  }

  useEffect(() => {
    if (!present) return
    return consumeTouchMoves(window, () => drag.current?.axis === 'y')
  }, [present])

  if (!present) return null
  return (
    <div className="sheet-layer" ref={layer}>
      <motion.div className="sheet-scrim" style={{ opacity: scrimOpacity }} onClick={onClose} aria-hidden="true" data-testid="sheet-scrim" />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`sheet${className ? ` ${className}` : ''}`}
        style={reduced ? { y, opacity: fade } : { y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // 输入框获得焦点（要弹出软键盘）时展开到全屏
        onFocusCapture={(e) => {
          if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
            if (snap.current !== 'full') goTo('full')
          }
        }}
        data-snap={snapState}
        data-testid="bottom-sheet"
      >
        <div className="sheet-grip" data-sheet-drag="" aria-hidden="true">
          <span />
        </div>
        {children}
      </motion.div>
    </div>
  )
}

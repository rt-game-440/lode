import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EDGE_OPEN_BAND,
  EDGE_OPEN_RATIO,
  LONG_PRESS_MS,
  VelocityTracker,
  consumeTouchMoves,
  followOpen,
  inEdgeBand,
  inHorizontalScroller,
  lockAxis,
  rubberband,
  shouldComplete,
} from '../lib/gesture'
import { fadeTransition, springPanel, springSheet } from '../styles/tokens/motion'
import { useFocusTrap } from './Modal'
import './drawer.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  /** 从哪一侧滑出 */
  side?: 'left' | 'right'
  /** 无障碍名称 */
  label: string
  children: ReactNode
  className?: string
  /**
   * 从屏幕侧边向内滑动拉出抽屉。zone 是允许起手的区域（CSS 选择器），起点还要落在靠抽屉那一侧边缘的窄带里；
   * 拉出到位（按位置和速度判断）时调用 onOpen，由调用方把 open 设为 true。
   * zone 里的横向拖动要交给脚本：给它设 `touch-action: pan-y`（见 shell.css）。
   */
  edgeSwipe?: { zone: string; onOpen: () => void }
}

/** 拉出手势的状态。base 为起手时抽屉偏离完全打开位置的距离，null 表示从完全收起开始（还不知道宽度）。 */
interface EdgeDrag {
  id: number
  x0: number
  y0: number
  t0: number
  base: number | null
  /** 手指朝打开方向走过的距离（锁定方向之后） */
  d: number
  taken: boolean
  v: VelocityTracker
}

/**
 * 侧边抽屉：从屏幕一侧滑出，带遮罩。
 * - 跟手拖拽关闭：在抽屉或遮罩上横向拖动时抽屉随手指移动，往打开方向拖有阻力；松手按速度投射决定关闭还是回弹。
 * - 跟手拉出（edgeSwipe）：从屏幕边缘的窄带向内滑，方向锁定为横向后抽屉 1:1 跟手拉出，中途可以反向；
 *   松手按位置和速度投射决定展开还是收回。
 * - 纵向拖动交给内容滚动（touch-action: pan-y + 方向锁定）。
 * - 打开时焦点移入抽屉、Tab 在抽屉内循环（useFocusTrap），Esc 关闭，关闭后焦点回到打开前的位置。
 * - 减弱动态效果时不滑动：抽屉停在打开位置，拖拽和开合都改为淡入淡出（透明度跟随进度）。
 */
export function Drawer({ open, onClose, side = 'right', label, children, className, edgeSwipe }: DrawerProps) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(open)
  const presentRef = useRef(present)
  presentRef.current = present
  /** 正在用手势从边缘拉出（open 还是 false） */
  const [pulling, setPulling] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const sign = side === 'right' ? 1 : -1
  /** 抽屉偏离完全打开位置的距离（px，朝关闭方向为正） */
  const offset = useMotionValue(10_000)
  const widthRef = useRef(0)
  const x = useTransform(offset, (v) => v * sign)
  /** 打开进度 0–1：遮罩透明度；减弱动态效果时也是抽屉本身的透明度 */
  const progress = useTransform(offset, (v) => (widthRef.current ? Math.max(0, Math.min(1, 1 - v / widthRef.current)) : 0))
  /** 这次开合由手势松手触发：带动量，用 springSheet；其他方式（按钮、Esc、点遮罩）用 springPanel */
  const flung = useRef(false)
  const edge = useRef<EdgeDrag | null>(null)

  useFocusTrap(panel, open && present)

  if (open && !present) setPresent(true)

  // 打开：从当前位置（关闭位置，或被手指拉到一半）弹到打开位置；关闭：从当前位置继续，继承速度
  useLayoutEffect(() => {
    if (!present) return
    const el = panel.current
    if (!el) return
    widthRef.current = el.offsetWidth
    const w = widthRef.current
    if (pulling) {
      // 拉出途中只跟手，不做动画；按下时抽屉还没挂载，这里补上宽度后定位
      const s = edge.current
      if (s) offset.set(followOpen(s.base ?? w, s.d, w))
      return
    }
    if (offset.get() > w) offset.set(w)
    const target = open ? 0 : w
    const finish = () => {
      if (open) return
      setPresent(false)
      offset.set(10_000)
    }
    const transition = reduced ? fadeTransition : flung.current ? springSheet : springPanel
    flung.current = false
    const c = animate(offset, target, { ...transition, onComplete: finish })
    return () => c.stop()
  }, [open, present, pulling, reduced, offset])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // 与 Modal 一致：捕获阶段处理，先于页面上其他 Esc 处理
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // ---- 从边缘拉出 ----
  const onOpenRef = useRef(edgeSwipe?.onOpen)
  onOpenRef.current = edgeSwipe?.onOpen
  const zone = edgeSwipe?.zone
  useEffect(() => {
    if (!zone || open) return
    const onDown = (e: globalThis.PointerEvent) => {
      if (edge.current || e.pointerType === 'mouse' || !e.isPrimary) return
      const area = document.querySelector(zone)
      const target = e.target instanceof Element ? e.target : null
      if (!area || !target || !area.contains(target)) return
      if (!inEdgeBand(e.clientX, area.getBoundingClientRect(), side, EDGE_OPEN_BAND)) return
      // 宽代码块、表格等能横向滚动的内容：横向拖动留给它们
      if (inHorizontalScroller(target, area)) return
      edge.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        t0: e.timeStamp,
        base: null,
        d: 0,
        taken: false,
        v: new VelocityTracker(),
      }
    }
    const onMove = (e: globalThis.PointerEvent) => {
      const s = edge.current
      if (!s || s.id !== e.pointerId) return
      const d = (s.x0 - e.clientX) * sign
      if (!s.taken) {
        const axis = lockAxis(d, e.clientY - s.y0, 10, EDGE_OPEN_RATIO)
        if (!axis) return
        // 纵向（滚动）、朝关闭方向、或长按之后才拖（选字）：都不接管
        if (axis === 'y' || d < 0 || e.timeStamp - s.t0 > LONG_PRESS_MS) {
          edge.current = null
          return
        }
        // 锁定方向前的防抖距离不计入位移，抽屉从边缘开始跟手，不跳一下；
        // 接住正在收起的抽屉时从它此刻的位置开始
        s.x0 = e.clientX
        s.base = presentRef.current ? offset.get() : null
        s.taken = true
        setPresent(true)
        setPulling(true)
        return
      }
      s.d = d
      s.v.add(d, e.timeStamp)
      const w = widthRef.current
      if (w && presentRef.current) offset.set(followOpen(s.base ?? w, d, w))
    }
    const onUp = (e: globalThis.PointerEvent) => {
      const s = edge.current
      if (!s || s.id !== e.pointerId) return
      edge.current = null
      if (!s.taken) return
      const w = widthRef.current
      flung.current = true
      // pointercancel（系统接管了手势，例如 Android 的返回手势）不按速度判断，直接收回
      if (e.type === 'pointerup' && w && shouldComplete(w - offset.get(), s.v.velocity(), w)) onOpenRef.current?.()
      setPulling(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      edge.current = null
    }
  }, [zone, open, side, sign, offset])

  // ---- 跟手拖拽关闭（抽屉和遮罩上都可以） ----
  const g = useRef<{ id: number; x0: number; y0: number; base: number; axis: 'x' | 'y' | null; v: VelocityTracker } | null>(null)
  /** 刚在遮罩上拖过：鼠标拖动松手后的 click 不算点遮罩 */
  const dragged = useRef(false)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!open || (e.pointerType === 'mouse' && e.button !== 0)) return
    dragged.current = false
    g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: offset.get(), axis: null, v: new VelocityTracker() }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (!s || s.id !== e.pointerId) return
    if (!s.axis) {
      s.axis = lockAxis((e.clientX - s.x0) * sign, e.clientY - s.y0)
      if (s.axis !== 'x') {
        if (s.axis === 'y') g.current = null
        return
      }
      // 锁定方向前的防抖距离不计入位移，抽屉从当前位置开始跟手
      s.x0 = e.clientX
      dragged.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const dx = (e.clientX - s.x0) * sign
    const raw = s.base + dx
    offset.set(raw >= 0 ? raw : -rubberband(-raw, widthRef.current))
    s.v.add(dx, e.timeStamp)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    g.current = null
    if (!s || s.axis !== 'x' || s.id !== e.pointerId) return
    // pointercancel（系统接管了手势）不按速度判断，直接弹回
    if (e.type === 'pointerup' && shouldComplete(offset.get(), s.v.velocity(), widthRef.current)) {
      flung.current = true
      onClose()
    } else animate(offset, 0, reduced ? fadeTransition : springSheet)
  }
  const drag = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

  // 拉出或拖拽接管后，这次触摸的 touchmove 不再交给浏览器（否则甩完后的第一次点按会被吞掉）
  useEffect(() => {
    if (!present && !zone) return
    return consumeTouchMoves(window, () => !!edge.current?.taken || g.current?.axis === 'x')
  }, [present, zone])

  if (!present) return null
  return (
    <>
      <motion.div
        className="drawer-scrim"
        style={{ opacity: progress }}
        onClick={() => {
          if (!dragged.current) onClose()
          dragged.current = false
        }}
        aria-hidden="true"
        data-testid="drawer-scrim"
        {...drag}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`drawer drawer-${side}${className ? ` ${className}` : ''}`}
        style={reduced ? { opacity: progress } : { x }}
        {...drag}
      >
        {children}
      </motion.div>
    </>
  )
}

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { VelocityTracker, lockAxis, rubberband, shouldComplete } from '../lib/gesture'
import { springPanel, springSheet } from '../styles/tokens/motion'
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
}

/**
 * 侧边抽屉：从屏幕一侧滑出，带遮罩。
 * - 跟手拖拽关闭：横向拖动时抽屉随手指移动，往打开方向拖有阻力；松手按速度投射决定关闭还是回弹。
 * - 纵向拖动交给内容滚动（touch-action: pan-y + 方向锁定）。
 * - 打开时焦点移入抽屉，Esc 关闭，关闭后焦点回到打开前的位置。
 * - 减弱动态效果时不滑动，直接出现和消失（遮罩仍淡入淡出）。
 */
export function Drawer({ open, onClose, side = 'right', label, children, className }: DrawerProps) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(open)
  const panel = useRef<HTMLDivElement>(null)
  const sign = side === 'right' ? 1 : -1
  /** 抽屉偏离完全打开位置的距离（px，朝关闭方向为正） */
  const offset = useMotionValue(10_000)
  const widthRef = useRef(0)
  const x = useTransform(offset, (v) => v * sign)
  const scrim = useTransform(offset, (v) => (widthRef.current ? Math.max(0, Math.min(1, 1 - v / widthRef.current)) : 0))
  const restoreFocus = useRef<HTMLElement | null>(null)

  if (open && !present) setPresent(true)

  // 打开：从关闭位置弹出；关闭：从当前位置（可能是拖到一半）继续，继承速度
  useLayoutEffect(() => {
    if (!present) return
    const el = panel.current
    if (!el) return
    widthRef.current = el.offsetWidth
    if (open) {
      if (offset.get() > widthRef.current) offset.set(widthRef.current)
      restoreFocus.current ??= document.activeElement as HTMLElement | null
      el.focus({ preventScroll: true })
    }
    const target = open ? 0 : widthRef.current
    const finish = () => {
      if (open) return
      setPresent(false)
      offset.set(10_000)
      restoreFocus.current?.focus?.({ preventScroll: true })
      restoreFocus.current = null
    }
    if (reduced) {
      offset.set(target)
      finish()
      return
    }
    const c = animate(offset, target, { ...(open ? springPanel : springSheet), onComplete: finish })
    return () => c.stop()
  }, [open, present, reduced, offset])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // ---- 跟手拖拽 ----
  const g = useRef<{ id: number; x0: number; y0: number; base: number; axis: 'x' | 'y' | null; v: VelocityTracker } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!open || (e.pointerType === 'mouse' && e.button !== 0)) return
    g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: offset.get(), axis: null, v: new VelocityTracker() }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (!s || s.id !== e.pointerId) return
    const dx = (e.clientX - s.x0) * sign
    if (!s.axis) {
      s.axis = lockAxis(dx, e.clientY - s.y0)
      if (s.axis !== 'x') {
        if (s.axis === 'y') g.current = null
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    const raw = s.base + dx
    offset.set(raw >= 0 ? raw : -rubberband(-raw, widthRef.current))
    s.v.add(dx, e.timeStamp)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    g.current = null
    if (!s || s.axis !== 'x' || s.id !== e.pointerId) return
    if (shouldComplete(offset.get(), s.v.velocity(), widthRef.current)) onClose()
    else animate(offset, 0, springSheet)
  }

  if (!present) return null
  return (
    <>
      <motion.div className="drawer-scrim" style={{ opacity: scrim }} onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`drawer drawer-${side}${className ? ` ${className}` : ''}`}
        style={{ x }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {children}
      </motion.div>
    </>
  )
}

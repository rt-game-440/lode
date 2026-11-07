import { type MotionValue, animate, motion, useMotionValueEvent } from 'motion/react'
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { clampRubber } from '../../lib/gesture'
import { SIDEBAR_WIDTH, clampSidebarWidth, useUI } from '../../stores/ui'
import { springSnappy } from '../../styles/tokens/motion'

/** 拖到比最小宽度还窄这么多时，松手收起侧栏（与 Finder 的侧栏一致）。 */
const COLLAPSE_BEYOND = 72
const STEP = 16

/**
 * 侧栏右缘的调宽手柄：拖拽跟手，越过最小 / 最大宽度时有阻力；
 * 键盘可用方向键调整（Shift 加大步长），Home / End 到最小 / 最大，双击恢复默认宽度。
 */
export function SidebarResizer({ width, x }: { width: MotionValue<number>; x: MotionValue<number> }) {
  const setWidth = useUI((s) => s.setSidebarWidth)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const drag = useRef<{ startX: number; startW: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(() => Math.round(width.get()))
  useMotionValueEvent(width, 'change', (w) => setNow(Math.round(w)))

  const commit = (w: number) => {
    const final = clampSidebarWidth(w)
    if (final !== Math.round(width.get())) animate(width, final, springSnappy)
    setWidth(final)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: width.get() }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const raw = d.startW + e.clientX - d.startX
    width.set(clampRubber(raw, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max, 160))
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    const raw = d.startW + e.clientX - d.startX
    if (raw < SIDEBAR_WIDTH.min - COLLAPSE_BEYOND) {
      // 收起时保持当前宽度做动画；下次展开时恢复保存的宽度
      toggleSidebar(false)
      setWidth(d.startW)
      return
    }
    commit(raw)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 3 : STEP
    const cur = width.get()
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = cur - step
    else if (e.key === 'ArrowRight') next = cur + step
    else if (e.key === 'Home') next = SIDEBAR_WIDTH.min
    else if (e.key === 'End') next = SIDEBAR_WIDTH.max
    if (next === null) return
    e.preventDefault()
    commit(next)
  }

  return (
    <motion.div
      className={`shell-resizer${dragging ? ' is-dragging' : ''}`}
      style={{ x }}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={now}
      tabIndex={0}
      data-testid="sidebar-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => commit(SIDEBAR_WIDTH.default)}
      onKeyDown={onKeyDown}
    />
  )
}

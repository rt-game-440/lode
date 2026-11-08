import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { agentBackAction } from '../../lib/agentNav'
import { VelocityTracker, consumeTouchMoves, lockAxis, rubberband, shouldComplete } from '../../lib/gesture'
import { useEditor } from '../../stores/editor'
import { type Route, useUI } from '../../stores/ui'
import { springPanel, springSheet } from '../../styles/tokens/motion'

/** 下层列表在详情页完全盖住时向左错开的比例（iOS 导航栈的视差）。 */
const PARALLAX = 0.3
/** 下层列表被盖住时的最大遮暗程度。 */
const DIM = 0.35

export function goBack() {
  const ui = useUI.getState()
  if (ui.route.view === 'agent') ui.agentBack()
  else ui.navigate({ view: 'home' })
}

/**
 * 手机单栏导航栈：文件树在下层，笔记等详情页从右侧推入。
 * 从屏幕左缘向右滑可以返回：详情页跟手移动，下层列表带视差露出；
 * 松手按速度投射决定返回还是弹回，返回时的动画继承手指的速度。
 */
export function MobileStack({ list, detail }: { list: ReactNode; detail: (route: Route) => ReactNode }) {
  const route = useUI((s) => s.route)
  const pane = useUI((s) => s.mobilePane)
  const reduced = useReducedMotion()
  const stack = useRef<HTMLDivElement>(null)
  const widthRef = useRef(typeof window === 'undefined' ? 375 : window.innerWidth)
  /** 详情页的横向位移：0 为完全显示，等于宽度时完全移出 */
  const dx = useMotionValue(pane === 'detail' ? 0 : widthRef.current)
  const [shown, setShown] = useState<Route | null>(pane === 'detail' ? route : null)
  /** 详情页稳定地完全盖住列表（此时列表不可见、不可交互） */
  const [covered, setCovered] = useState(pane === 'detail')
  /** 这次返回由手势甩出触发：带动量，用有轻微回弹的 springSheet；点返回按钮则用 springPanel */
  const flung = useRef(false)
  /** 返回到另一个详情页（例如助手页回到来源笔记）：甩出后换内容，换好了再把详情页放回原位 */
  const resetOnRoute = useRef(false)
  useLayoutEffect(() => {
    if (!resetOnRoute.current) return
    resetOnRoute.current = false
    dx.set(0)
    setCovered(true)
  }, [route, dx])

  if (pane === 'detail' && route.view !== 'home' && shown !== route) setShown(route)

  const progress = (v: number) => Math.max(0, Math.min(1, v / widthRef.current))
  const listX = useTransform(dx, (v) => (progress(v) - 1) * widthRef.current * PARALLAX)
  const dim = useTransform(dx, (v) => (1 - progress(v)) * DIM)

  useLayoutEffect(() => {
    widthRef.current = stack.current?.offsetWidth || window.innerWidth
    setCovered(false)
    const w = widthRef.current
    if (pane === 'detail') {
      if (dx.get() > w) dx.set(w)
      const done = () => setCovered(true)
      if (reduced) {
        dx.set(0)
        done()
        return
      }
      const c = animate(dx, 0, { ...springPanel, onComplete: done })
      return () => c.stop()
    }
    const done = () => {
      setShown(null)
      if (useUI.getState().route.view !== 'note') useEditor.getState().close()
    }
    if (reduced) {
      dx.set(w)
      done()
      return
    }
    const spring = flung.current ? springSheet : springPanel
    flung.current = false
    const c = animate(dx, w, { ...spring, onComplete: done })
    return () => c.stop()
  }, [pane, reduced, dx])

  // ---- 左缘返回手势 ----
  const g = useRef<{ id: number; x0: number; y0: number; axis: 'x' | 'y' | null; v: VelocityTracker } | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  // 接管后这次触摸的 touchmove 不再交给浏览器，否则返回后的第一次点按会被吞掉（见 consumeTouchMoves）
  const hasStrip = shown !== null
  useEffect(() => {
    const el = strip.current
    if (!hasStrip || !el) return
    return consumeTouchMoves(el, () => g.current?.axis === 'x')
  }, [hasStrip])
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (pane !== 'detail' || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, v: new VelocityTracker() }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (!s || s.id !== e.pointerId) return
    if (!s.axis) {
      s.axis = lockAxis(e.clientX - s.x0, e.clientY - s.y0)
      if (s.axis !== 'x') return
      // 锁定方向前的防抖距离不计入位移，详情页从当前位置开始跟手，不跳一下
      s.x0 = e.clientX
      setCovered(false)
    }
    if (s.axis !== 'x') return
    const d = e.clientX - s.x0
    dx.set(d >= 0 ? d : -rubberband(-d, widthRef.current))
    s.v.add(d, e.timeStamp)
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    g.current = null
    if (!s || s.id !== e.pointerId) return
    if (s.axis === 'x') {
      // pointercancel（系统接管了手势）不按速度判断，直接弹回
      if (e.type === 'pointerup' && shouldComplete(dx.get(), s.v.velocity(), widthRef.current)) {
        flung.current = true
        const st = useUI.getState()
        if (st.route.view === 'agent' && agentBackAction(history.state) === 'history') {
          // 历史里的上一页还是详情页：下层列表不变，详情页甩出屏幕后再跳回去
          animate(dx, widthRef.current, {
            ...springSheet,
            onComplete: () => {
              resetOnRoute.current = true
              goBack()
            },
          })
        } else goBack()
      } else animate(dx, 0, { ...springSheet, onComplete: () => setCovered(true) })
      return
    }
    if (s.axis === null && e.type === 'pointerup') forwardTap(e.currentTarget, e.clientX, e.clientY)
  }

  return (
    <div className="mobile-stack" ref={stack}>
      <motion.div
        className="mobile-layer is-list"
        style={{ x: shown ? listX : 0, visibility: covered ? 'hidden' : 'visible' }}
        inert={pane === 'detail'}
        aria-hidden={pane === 'detail' ? true : undefined}
      >
        {list}
        {shown && <motion.div className="mobile-dim" style={{ opacity: dim }} aria-hidden="true" />}
      </motion.div>
      {shown && (
        <motion.div
          className="mobile-layer is-detail"
          style={{ x: dx }}
          inert={pane !== 'detail'}
          aria-hidden={pane !== 'detail' ? true : undefined}
        >
          {detail(shown)}
          <div
            ref={strip}
            className="edge-swipe"
            data-testid="edge-swipe"
            aria-hidden="true"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        </motion.div>
      )}
    </div>
  )
}

/** 边缘手势区域盖住了下面的元素：轻点（没有拖动）时把点击转给下面的元素。 */
function forwardTap(strip: HTMLElement, x: number, y: number) {
  strip.style.pointerEvents = 'none'
  const below = document.elementFromPoint(x, y) as HTMLElement | null
  strip.style.pointerEvents = ''
  if (!below) return
  below.focus?.({ preventScroll: true })
  below.click()
}

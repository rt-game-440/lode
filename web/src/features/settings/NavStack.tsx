import { type AnimationPlaybackControls, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { VelocityTracker, lockAxis, rubberband, shouldComplete } from '../../lib/gesture'
import { fadeTransition, springPanel, springSheet } from '../../styles/tokens/motion'
import { pathKey, prefixes, stackChange } from './stack'

/** 下层页面被完全盖住时向左错开的比例（和 MobileStack 一致的 iOS 视差）。 */
const PARALLAX = 0.3
/** 下层页面被盖住时的最大遮暗程度。 */
const DIM = 0.35

interface Props {
  /** 当前页面的路径（/settings 之后的各段） */
  path: string[]
  renderPage: (sub: string[]) => ReactNode
  /** 返回上一级（左缘手势松手越过一半时调用） */
  onBack: () => void
  /** 手机上在子页面左缘提供返回手势 */
  edgeSwipe: boolean
}

/**
 * 设置的多级导航栈：从首页到当前页的每一层都保持挂载（返回时停在原来的滚动位置），
 * 更深一级从右侧推入、下层带视差向左错开并变暗，返回时反向推出。
 *
 * 位移只用一个 motion value：最上面那层（进入中、退出中或正在拖动的页面）的 x，
 * 它下面那层的位置和遮暗都由它推导，所以动画和手势可以随时中断、反向。
 * 减弱动态效果时不位移，最上层改为淡入淡出。
 */
export function NavStack({ path, renderPage, onBack, edgeSwipe }: Props) {
  const reduced = useReducedMotion()
  const root = useRef<HTMLDivElement>(null)
  const width = useRef(typeof window === 'undefined' ? 375 : window.innerWidth)
  /** 渲染中的各层；推出动画期间最后一层是正在退出的页面 */
  const [layers, setLayers] = useState<string[][]>(() => prefixes(path))
  /** 没有动画或手势在进行（此时下层完全被盖住，不渲染） */
  const [settled, setSettled] = useState(true)
  const dx = useMotionValue(0)
  const fade = useMotionValue(1)
  const prev = useRef(path)
  const anim = useRef<AnimationPlaybackControls | null>(null)
  /** 这次返回由手势甩出触发：带动量，用有轻微回弹的 springSheet */
  const flung = useRef(false)
  /** 被盖住的页面里原来的焦点，返回时还给它 */
  const focusMemo = useRef(new Map<string, HTMLElement>())
  const pendingFocus = useRef<string | null>(null)
  const key = pathKey(path)

  const progress = (v: number) => Math.max(0, Math.min(1, v / width.current))
  const underX = useTransform(dx, (v) => (progress(v) - 1) * width.current * PARALLAX)
  const dim = useTransform(dx, (v) => (1 - progress(v)) * DIM)

  const layerEl = (k: string) =>
    Array.from(root.current?.children ?? []).find((el) => (el as HTMLElement).dataset.path === k) as HTMLElement | undefined

  useLayoutEffect(() => {
    const from = prev.current
    prev.current = path
    const change = stackChange(from, path)
    if (change === 'none') return
    width.current = root.current?.offsetWidth || window.innerWidth
    const w = width.current
    const front = layers[layers.length - 1]
    anim.current?.stop()
    const settle = () => {
      anim.current = null
      setSettled(true)
    }
    pendingFocus.current = key

    if (change === 'replace') {
      setLayers(prefixes(path))
      dx.set(0)
      fade.set(1)
      settle()
      return
    }
    setSettled(false)

    if (change === 'push') {
      const active = document.activeElement as HTMLElement | null
      const covered = layerEl(pathKey(from))
      if (active && covered?.contains(active)) focusMemo.current.set(pathKey(from), active)
      // 正在退出的页面又被推入（例如很快地后退再前进）：从当前位置接着走，不跳回右边
      const reentering = pathKey(front) === key
      setLayers(prefixes(path))
      if (reduced) {
        dx.set(0)
        if (!reentering) fade.set(0)
        anim.current = animate(fade, 1, { ...fadeTransition, onComplete: settle })
      } else {
        if (!reentering) dx.set(w)
        fade.set(1)
        anim.current = animate(dx, 0, { ...springPanel, onComplete: settle })
      }
      return
    }

    // 推出：原来的顶层作为退出层留在最上面，直到动画结束
    if (pathKey(front) !== pathKey(from)) {
      dx.set(0)
      fade.set(1)
    }
    setLayers([...prefixes(path), from])
    const spring = flung.current ? springSheet : springPanel
    flung.current = false
    const finish = () => {
      setLayers(prefixes(path))
      dx.set(0)
      fade.set(1)
      settle()
    }
    anim.current = reduced ? animate(fade, 0, { ...fadeTransition, onComplete: finish }) : animate(dx, w, { ...spring, onComplete: finish })
    // 只在路径变化时运行；layers 取这次渲染时的值
  }, [key])

  useEffect(() => () => anim.current?.stop(), [])

  // 推入后焦点移到新页面的标题，返回后回到进入子页面前的那个元素
  useEffect(() => {
    const k = pendingFocus.current
    if (k === null || k !== key) return
    // 推入时新的一层要到下一次提交才出现：等它出现再移动焦点
    const el = layerEl(k)
    if (!el) return
    pendingFocus.current = null
    const memo = focusMemo.current.get(k)
    focusMemo.current.delete(k)
    const target = memo?.isConnected && el.contains(memo) ? memo : el.querySelector<HTMLElement>('[data-stack-heading]')
    target?.focus({ preventScroll: true })
  }, [layers, key])

  // ---- 左缘返回手势（和 MobileStack 的返回手势相同的跟手和投射规则） ----
  const g = useRef<{ id: number; x0: number; y0: number; axis: 'x' | 'y' | null; v: VelocityTracker } | null>(null)
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, v: new VelocityTracker() }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (!s || s.id !== e.pointerId) return
    if (!s.axis) {
      s.axis = lockAxis(e.clientX - s.x0, e.clientY - s.y0)
      if (s.axis !== 'x') return
      // 锁定方向前的防抖距离不计入位移，页面从当前位置开始跟手
      s.x0 = e.clientX
      anim.current?.stop()
      width.current = root.current?.offsetWidth || window.innerWidth
      setSettled(false)
    }
    if (s.axis !== 'x') return
    const d = e.clientX - s.x0
    dx.set(d >= 0 ? d : -rubberband(-d, width.current))
    s.v.add(d, e.timeStamp)
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    g.current = null
    if (!s || s.id !== e.pointerId) return
    if (s.axis === 'x') {
      // pointercancel（系统接管了手势）不按速度判断，直接弹回
      if (e.type === 'pointerup' && shouldComplete(dx.get(), s.v.velocity(), width.current)) {
        flung.current = true
        onBack()
      } else {
        anim.current = animate(dx, 0, {
          ...springSheet,
          onComplete: () => {
            anim.current = null
            setSettled(true)
          },
        })
      }
      return
    }
    if (s.axis === null && e.type === 'pointerup') forwardTap(e.currentTarget, e.clientX, e.clientY)
  }

  return (
    <div className="settings-stack" ref={root} data-depth={path.length}>
      {layers.map((sub, i) => {
        const k = pathKey(sub)
        const isFront = i === layers.length - 1
        const isUnder = i === layers.length - 2
        const isTop = k === key
        const visible = isFront || isTop || (isUnder && !settled)
        const motionStyle = isFront ? { x: dx, opacity: fade } : isUnder && !reduced ? { x: underX } : { x: 0 }
        return (
          <motion.div
            key={k}
            className="settings-layer"
            data-path={k}
            style={{ ...motionStyle, visibility: visible ? 'visible' : 'hidden' }}
            inert={!isTop}
            aria-hidden={isTop ? undefined : true}
          >
            {renderPage(sub)}
            {isUnder && !reduced && <motion.div className="settings-dim" style={{ opacity: dim }} aria-hidden="true" />}
            {isFront && isTop && edgeSwipe && sub.length > 0 && (
              <div
                className="edge-swipe"
                data-testid="settings-edge-swipe"
                aria-hidden="true"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
            )}
          </motion.div>
        )
      })}
    </div>
  )
}

/** 边缘手势区域盖住了下面的元素：轻点（没有拖动）时把点击转给下面的元素（同 MobileStack）。 */
function forwardTap(strip: HTMLElement, x: number, y: number) {
  strip.style.pointerEvents = 'none'
  const below = document.elementFromPoint(x, y) as HTMLElement | null
  strip.style.pointerEvents = ''
  if (!below) return
  below.focus?.({ preventScroll: true })
  below.click()
}

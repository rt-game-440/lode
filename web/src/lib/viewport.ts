/**
 * 跟踪 visualViewport，把可视区域的高度和偏移写成 CSS 变量：
 * - --vv-height：可视区域高度（虚拟键盘弹出后变小）；
 * - --vv-top：可视区域相对布局视口的偏移（iOS 聚焦输入框时会平移页面）；
 * - --keyboard-inset：被键盘等遮住的底部高度。
 * 手机布局用它们让外壳贴合可视区域，编辑器光标和底部工具栏不会被键盘挡住。
 */
export interface ViewportMetrics {
  height: number
  top: number
  keyboard: number
}

/** 由布局视口高度和 visualViewport 算出可视区域。键盘高度小于 threshold 时视为没有键盘（地址栏伸缩等）。 */
export function viewportMetrics(layoutHeight: number, vvHeight: number, vvOffsetTop: number, threshold = 80): ViewportMetrics {
  const top = Math.max(0, vvOffsetTop)
  const covered = Math.max(0, layoutHeight - vvHeight - top)
  return { height: vvHeight, top, keyboard: covered >= threshold ? covered : 0 }
}

const listeners = new Set<(m: ViewportMetrics) => void>()
let current: ViewportMetrics | null = null

/** 订阅可视区域变化（键盘弹出、收起）。 */
export function onViewportChange(fn: (m: ViewportMetrics) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function keyboardOpen(): boolean {
  return (current?.keyboard ?? 0) > 0
}

export function installViewportTracking() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement.style
  let frame = 0
  const update = () => {
    frame = 0
    const m = viewportMetrics(window.innerHeight, vv.height, vv.offsetTop)
    current = m
    root.setProperty('--vv-height', `${m.height}px`)
    root.setProperty('--vv-top', `${m.top}px`)
    root.setProperty('--keyboard-inset', `${m.keyboard}px`)
    for (const fn of listeners) fn(m)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  vv.addEventListener('resize', schedule)
  vv.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  update()
}

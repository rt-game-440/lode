/**
 * 手势的物理计算：速度跟踪、按动量投射落点、边界橡皮筋。
 * 参照 Apple《Designing Fluid Interfaces》的做法：松手时用速度投射出“会停在哪里”，再决定完成还是取消。
 */

/** 记录最近一小段时间的位置，松手时算出速度（px/s）。 */
export class VelocityTracker {
  private samples: { t: number; x: number }[] = []
  /** 只用最近这么长时间内的采样算速度 */
  private readonly windowMs = 100

  add(x: number, t: number) {
    this.samples.push({ t, x })
    const cutoff = t - this.windowMs
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  /** 最早与最新样本之间的平均速度；样本不足或时间太短时为 0。 */
  velocity(): number {
    const n = this.samples.length
    if (n < 2) return 0
    const a = this.samples[0]
    const b = this.samples[n - 1]
    const dt = b.t - a.t
    return dt > 0 ? ((b.x - a.x) / dt) * 1000 : 0
  }
}

/**
 * 按滚动减速的方式投射：以 velocity（px/s）松手后还会再走多远。
 * decelerationRate 0.998 接近系统滚动手感，0.99 更快停下。
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/** 越过边界后的阻力：越往外拖，跟随得越少，不会硬停。 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/** 把位置限制在 [min, max]，超出部分按橡皮筋衰减。 */
export function clampRubber(value: number, min: number, max: number, dimension: number): number {
  if (value < min) return min - rubberband(min - value, dimension)
  if (value > max) return max + rubberband(value - max, dimension)
  return value
}

/**
 * 两段式手势（例如返回、关闭抽屉）松手时的决定：
 * 投射落点越过一半就完成，否则回到原位。position 和 distance 同向为正。
 */
export function shouldComplete(position: number, velocity: number, distance: number): boolean {
  return position + project(velocity, 0.99) > distance / 2
}

/** 横向手势的方向锁定：移动超过 slop 后，横向分量大于纵向的 ratio 倍才算横向手势。 */
export function lockAxis(dx: number, dy: number, slop = 10, ratio = 1.2): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < slop) return null
  return Math.abs(dx) > Math.abs(dy) * ratio ? 'x' : 'y'
}

// ---- 从屏幕侧边向内拉出面板（手机笔记页右缘左滑拉出右侧栏） ----

/**
 * 起手窄带的宽度（px，从屏幕边缘往里量）。Android 手势导航的返回区约 18–40dp（随“返回灵敏度”变化），
 * iOS Safari 的前进 / 后退手势约 20pt；落在系统区里的触摸由系统接管（页面收到 pointercancel，面板不动），
 * 窄带比系统区宽出的那一段在所有设备上都能起手。
 */
export const EDGE_OPEN_BAND = 56
/** 在编辑区里起手，横向分量要明显大于纵向才接管，斜着拖仍然是滚动。 */
export const EDGE_OPEN_RATIO = 1.5
/** 按住超过这么久才开始拖动，多半是长按选字，不接管。 */
export const LONG_PRESS_MS = 500

/** 起点 x 是否落在 rect 靠 side 一侧、宽 band 的窄带里。 */
export function inEdgeBand(x: number, rect: { left: number; right: number }, side: 'left' | 'right', band: number): boolean {
  return side === 'right' ? x <= rect.right && x >= rect.right - band : x >= rect.left && x <= rect.left + band
}

/**
 * 拉出面板时的跟手位置：base 是起手时面板偏离完全展开位置的距离（完全收起时等于 width），
 * d 是手指朝展开方向走过的距离。返回新的偏离距离：1:1 跟手；往回拖超过起点停在收起位置；拉过完全展开有橡皮筋阻力。
 */
export function followOpen(base: number, d: number, width: number): number {
  const raw = base - d
  if (raw > width) return width
  return raw >= 0 ? raw : -rubberband(-raw, width)
}

/**
 * target 到 stop（不含）之间有没有正在横向溢出、可以横向滚动的元素（宽代码块、表格等）。
 * 有就把横向拖动留给它，不当成拉出面板的手势。
 */
export function inHorizontalScroller(target: Element, stop: Element): boolean {
  for (let el: Element | null = target; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const ox = getComputedStyle(el).overflowX
    if (ox === 'auto' || ox === 'scroll') return true
  }
  return false
}

/**
 * 横向手势接管之后，把同一次触摸后续的 touchmove 标记为已处理（preventDefault）。
 * 不这样做的话，浏览器仍把这次触摸当成一次被 touch-action 拦下的滚动：松手时照样生成惯性滚动（fling），
 * 它不滚动任何东西，却会让下一次轻点被当成“停住惯性”吞掉（Chromium 的 tap suppression），
 * 表现为甩完抽屉后第一次点按没有反应。React 的 onTouchMove 是 passive 的，这里必须用原生的非 passive 监听。
 * 返回取消监听的函数。
 */
export function consumeTouchMoves(target: EventTarget, taken: () => boolean): () => void {
  const onMove = (e: Event) => {
    if (e.cancelable && taken()) e.preventDefault()
  }
  target.addEventListener('touchmove', onMove, { passive: false, capture: true })
  return () => target.removeEventListener('touchmove', onMove, { capture: true })
}

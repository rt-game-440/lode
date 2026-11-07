/**
 * 手势的物理计算：速度跟踪、按动量投射落点、边界橡皮筋。
 * 参照 Apple《Designing Fluid Interfaces》的做法：松手时用速度投射出“会停在哪里”，再决定完成还是取消。
 */

/** 记录最近一小段时间的位置，松手时算出速度（px/s）。 */
export class VelocityTracker {
  private samples: { t: number; x: number }[] = []
  constructor(private windowMs = 100) {}

  reset() {
    this.samples = []
  }

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

/** 横向手势的方向锁定：移动超过 slop 后，横向分量明显大于纵向才算横向手势。 */
export function lockAxis(dx: number, dy: number, slop = 10): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < slop) return null
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
}

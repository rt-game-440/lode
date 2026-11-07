/** 等高行列表的虚拟滚动计算（文件树在行数很多时使用）。 */

export interface VirtualWindow {
  /** 渲染 [start, end) 范围的行 */
  start: number
  end: number
  /** 上下占位高度（px） */
  padTop: number
  padBottom: number
}

export function virtualWindow(o: { count: number; rowHeight: number; scrollTop: number; viewport: number; overscan: number }): VirtualWindow {
  const first = Math.floor(Math.max(0, o.scrollTop) / o.rowHeight)
  const visible = Math.ceil(o.viewport / o.rowHeight)
  const start = Math.max(0, Math.min(first, o.count) - o.overscan)
  const end = Math.min(o.count, first + visible + o.overscan)
  return { start, end, padTop: start * o.rowHeight, padBottom: (o.count - end) * o.rowHeight }
}

/** 让第 index 行完整露出需要的 scrollTop；已经可见时返回 null。 */
export function scrollToShow(o: { index: number; rowHeight: number; scrollTop: number; viewport: number }): number | null {
  const top = o.index * o.rowHeight
  const bottom = top + o.rowHeight
  if (top < o.scrollTop) return top
  if (bottom > o.scrollTop + o.viewport) return bottom - o.viewport
  return null
}

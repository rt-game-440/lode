/**
 * 选区悬浮工具框的定位（#73）。纯函数，便于单测；坐标都是视口坐标（getBoundingClientRect）。
 */

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** 选区的几何：首尾两个位置各自所在行的矩形 */
export interface SelectionGeometry {
  /** 选区起点（from）所在行的左边和上下沿 */
  start: { left: number; top: number; bottom: number }
  /** 选区终点（to）所在行的右边和上下沿 */
  end: { right: number; top: number; bottom: number }
}

export interface PlaceOptions {
  /** 工具框尺寸 */
  size: { width: number; height: number }
  /** 工具框可以占用的区域（编辑区可见部分；手机上已去掉键盘和底部工具栏） */
  bounds: Box
  /** 优先放在选区上方还是下方：桌面上方，手机下方（上方留给系统的选区菜单） */
  prefer: 'above' | 'below'
  /** 放在上方时与选区的间距 */
  gapAbove: number
  /** 放在下方时与选区的间距（手机上要让出选区拖柄） */
  gapBelow: number
  /** 与 bounds 左右边缘保持的距离 */
  margin: number
}

export interface Placement {
  left: number
  top: number
  placement: 'above' | 'below'
  /** 工具框水平方向上对准的选区位置（相对工具框左边），用作弹出动画的原点 */
  originX: number
}

/** 选区与可见区域有没有交集：完全滚出去时返回 false（工具框隐藏）。 */
export function selectionVisible(g: SelectionGeometry, visible: Box): boolean {
  return g.end.bottom > visible.top && g.start.top < visible.bottom
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/**
 * 算工具框的位置：
 * - 垂直方向优先放在 prefer 那一侧，放不下时翻到另一侧；两侧都放不下（选区比可见区域还高）时贴着可见区域的边缘；
 * - 水平方向：单行选区居中对齐；多行时上方对齐首行起点、下方对齐末行终点；再夹到 bounds 以内。
 */
export function placeToolbar(g: SelectionGeometry, o: PlaceOptions): Placement {
  const { size, bounds, gapAbove, gapBelow, margin } = o
  const singleLine = Math.abs(g.start.top - g.end.top) < 2
  const aboveTop = g.start.top - gapAbove - size.height
  const belowTop = g.end.bottom + gapBelow
  const fitsAbove = aboveTop >= bounds.top
  const fitsBelow = belowTop + size.height <= bounds.bottom
  let placement: 'above' | 'below'
  if (o.prefer === 'above') placement = fitsAbove || !fitsBelow ? 'above' : 'below'
  else placement = fitsBelow || !fitsAbove ? 'below' : 'above'
  const rawTop = placement === 'above' ? aboveTop : belowTop
  const top = clamp(rawTop, bounds.top, bounds.bottom - size.height)

  let anchorX: number
  let rawLeft: number
  if (singleLine) {
    anchorX = (g.start.left + g.end.right) / 2
    rawLeft = anchorX - size.width / 2
  } else if (placement === 'above') {
    anchorX = g.start.left
    rawLeft = anchorX - Math.min(size.width / 2, 24)
  } else {
    anchorX = g.end.right
    rawLeft = anchorX - size.width + Math.min(size.width / 2, 24)
  }
  const left = clamp(rawLeft, bounds.left + margin, bounds.right - margin - size.width)
  return { left, top, placement, originX: clamp(anchorX - left, 0, size.width) }
}

import { project } from './gesture'

/** 半屏时面板露出的高度占可视区域高度的比例 */
export const SHEET_HALF = 0.55

/**
 * 底部面板各吸附点的偏移（px，0 为完全展开，数值越大面板越靠下）。
 * layer 是可视区域高度，height 是面板高度；半屏露出 layer 的 SHEET_HALF，不会超过面板本身的高度。
 */
export function sheetPoints(layer: number, height: number): { full: number; half: number; closed: number } {
  const visible = Math.min(height, layer * SHEET_HALF)
  return { full: 0, half: Math.max(0, height - visible), closed: height }
}

/**
 * 松手后面板停在哪：按速度（px/s，向下为正）把当前位置投射出去，取离投射落点最近的吸附点。
 * points 是升序的吸附点偏移，最后一个是关闭位置。
 */
export function sheetTarget(y: number, velocity: number, points: readonly number[]): number {
  const landing = y + project(velocity, 0.99)
  return points.reduce((best, p) => (Math.abs(p - landing) < Math.abs(best - landing) ? p : best), points[0])
}

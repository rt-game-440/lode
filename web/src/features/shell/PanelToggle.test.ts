import { describe, expect, it } from 'vitest'
import { slotWidth, softPlus, toggleOffset } from './PanelToggle'

// 按钮 32px、内边距 8px、间距 4px（桌面默认尺寸）
const SIZE = 32
const INSET = 8
const GAP = 4

describe('收起按钮的位置', () => {
  it('面板展开时贴着面板边缘（隔分隔线和内边距），收起后停在离窗口边缘一个内边距的角上', () => {
    for (const edge of [200, 264, 300, 420]) expect(toggleOffset(edge, SIZE, INSET)).toBe(edge - 1 - INSET - SIZE)
    expect(toggleOffset(0, SIZE, INSET)).toBe(INSET)
  })

  it('随面板边缘连续、单调变化，转角处速度没有突变', () => {
    let prev = toggleOffset(0, SIZE, INSET)
    let prevSlope = 0
    for (let e = 0.5; e <= 300; e += 0.5) {
      const x = toggleOffset(e, SIZE, INSET)
      const slope = (x - prev) / 0.5
      expect(slope).toBeGreaterThanOrEqual(0)
      expect(slope).toBeLessThanOrEqual(1 + 1e-9)
      expect(Math.abs(slope - prevSlope)).toBeLessThan(0.05)
      prev = x
      prevSlope = slope
    }
  })

  it('标题栏让位：面板展开时完全不让位，收起后正好让出按钮宽度加间距，且从不压住按钮', () => {
    const cover = (edge: number) => toggleOffset(edge, SIZE, INSET) + SIZE - edge
    for (const pad of [8, 12]) {
      expect(slotWidth(cover(264), GAP, pad)).toBe(0)
      expect(pad + slotWidth(cover(0), GAP, pad)).toBe(INSET + SIZE + GAP)
      for (let e = 0; e <= 300; e += 0.5) {
        // 标题栏内容的起点（从主区域边缘量起）不早于按钮右缘加间距
        expect(pad + slotWidth(cover(e), GAP, pad)).toBeGreaterThanOrEqual(cover(e) + GAP - 1e-9)
      }
    }
  })

  it('softPlus 两端与 max(0, x) 完全相同，中间不小于它', () => {
    expect(softPlus(-16, 16)).toBe(0)
    expect(softPlus(16, 16)).toBe(16)
    for (let x = -20; x <= 20; x += 0.25) expect(softPlus(x, 16)).toBeGreaterThanOrEqual(Math.max(0, x))
  })
})

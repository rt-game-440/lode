import { describe, expect, it } from 'vitest'
import { SHEET_HALF, sheetPoints, sheetTarget } from './sheet'

describe('sheetPoints', () => {
  it('半屏露出可视区域的一半多一点，关闭位置在面板高度处', () => {
    const p = sheetPoints(800, 760)
    expect(p.full).toBe(0)
    expect(p.closed).toBe(760)
    expect(p.half).toBeCloseTo(760 - 800 * SHEET_HALF)
  })

  it('面板比半屏还矮时，半屏就是完全展开', () => {
    expect(sheetPoints(800, 300).half).toBe(0)
  })
})

describe('sheetTarget', () => {
  const pts = [0, 340, 760]

  it('没有速度时停在最近的吸附点', () => {
    expect(sheetTarget(120, 0, pts)).toBe(0)
    expect(sheetTarget(250, 0, pts)).toBe(340)
    expect(sheetTarget(600, 0, pts)).toBe(760)
  })

  it('向下甩会越过中间的吸附点，向上甩回到上一个', () => {
    expect(sheetTarget(340, 4000, pts)).toBe(760)
    expect(sheetTarget(340, -4000, pts)).toBe(0)
    // 从完全展开向下轻甩，只落到半屏，不直接关闭
    expect(sheetTarget(0, 2500, pts)).toBe(340)
  })
})

import { describe, expect, it } from 'vitest'
import { type PlaceOptions, type SelectionGeometry, placeToolbar, selectionVisible } from './selectionLayout'

const bounds = { left: 0, top: 100, right: 800, bottom: 700 }
const opts = (o: Partial<PlaceOptions> = {}): PlaceOptions => ({
  size: { width: 200, height: 40 },
  bounds,
  prefer: 'above',
  gapAbove: 8,
  gapBelow: 8,
  margin: 8,
  ...o,
})
const line = (left: number, right: number, top: number, h = 24): SelectionGeometry => ({
  start: { left, top, bottom: top + h },
  end: { right, top, bottom: top + h },
})

describe('placeToolbar', () => {
  it('桌面默认放在单行选区上方并水平居中', () => {
    const p = placeToolbar(line(300, 500, 400), opts())
    expect(p.placement).toBe('above')
    expect(p.top).toBe(400 - 8 - 40)
    expect(p.left).toBe(400 - 100)
    expect(p.originX).toBe(100)
  })

  it('上方空间不够时翻到下方', () => {
    const p = placeToolbar(line(300, 500, 120), opts())
    expect(p.placement).toBe('below')
    expect(p.top).toBe(120 + 24 + 8)
  })

  it('手机优先放在下方，并留出拖柄的距离', () => {
    const p = placeToolbar(line(100, 200, 300), opts({ prefer: 'below', gapBelow: 28 }))
    expect(p.placement).toBe('below')
    expect(p.top).toBe(300 + 24 + 28)
  })

  it('手机下方放不下（键盘、底部工具栏）时改到上方', () => {
    const p = placeToolbar(line(100, 200, 650), opts({ prefer: 'below', gapBelow: 28 }))
    expect(p.placement).toBe('above')
    expect(p.top + 40).toBeLessThanOrEqual(650)
  })

  it('水平方向不超出编辑区', () => {
    expect(placeToolbar(line(0, 20, 400), opts()).left).toBe(8)
    expect(placeToolbar(line(780, 800, 400), opts()).left).toBe(800 - 8 - 200)
  })

  it('选区比可见区域还高时贴在可见区域内', () => {
    const g: SelectionGeometry = { start: { left: 50, top: 0, bottom: 24 }, end: { right: 300, top: 900, bottom: 924 } }
    const p = placeToolbar(g, opts())
    expect(p.top).toBeGreaterThanOrEqual(bounds.top)
    expect(p.top + 40).toBeLessThanOrEqual(bounds.bottom)
  })

  it('多行选区：上方对齐首行起点，下方对齐末行终点', () => {
    const g: SelectionGeometry = { start: { left: 300, top: 400, bottom: 424 }, end: { right: 500, top: 448, bottom: 472 } }
    const above = placeToolbar(g, opts())
    expect(above.placement).toBe('above')
    expect(above.left).toBe(300 - 24)
    const below = placeToolbar(g, opts({ prefer: 'below' }))
    expect(below.placement).toBe('below')
    expect(below.left + 200).toBe(500 + 24)
  })
})

describe('selectionVisible', () => {
  it('选区滚出可见区域时为 false', () => {
    expect(selectionVisible(line(0, 10, 50), bounds)).toBe(false)
    expect(selectionVisible(line(0, 10, 720), bounds)).toBe(false)
    expect(selectionVisible(line(0, 10, 90), bounds)).toBe(true)
  })
})

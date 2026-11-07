import { describe, expect, it } from 'vitest'
import { scrollToShow, virtualWindow } from './virtual'

describe('virtualWindow', () => {
  it('只渲染可见区域加上下缓冲，其余用占位高度补齐', () => {
    // 3000 行、每行 30px、视口 600px、滚到第 1000 行，缓冲 10 行
    const w = virtualWindow({ count: 3000, rowHeight: 30, scrollTop: 30000, viewport: 600, overscan: 10 })
    expect(w).toEqual({ start: 990, end: 1030, padTop: 990 * 30, padBottom: (3000 - 1030) * 30 })
  })

  it('顶部和底部不越界', () => {
    expect(virtualWindow({ count: 50, rowHeight: 30, scrollTop: 0, viewport: 600, overscan: 10 })).toEqual({
      start: 0,
      end: 30,
      padTop: 0,
      padBottom: 20 * 30,
    })
    const end = virtualWindow({ count: 50, rowHeight: 30, scrollTop: 5000, viewport: 600, overscan: 10 })
    expect(end.end).toBe(50)
    expect(end.padBottom).toBe(0)
  })
})

describe('scrollToShow', () => {
  it('目标行已可见时不滚动', () => {
    expect(scrollToShow({ index: 5, rowHeight: 30, scrollTop: 0, viewport: 600 })).toBeNull()
  })
  it('目标行在下方时滚到它恰好露出底边', () => {
    expect(scrollToShow({ index: 100, rowHeight: 30, scrollTop: 0, viewport: 600 })).toBe(101 * 30 - 600)
  })
  it('目标行在上方时滚到它贴着顶边', () => {
    expect(scrollToShow({ index: 10, rowHeight: 30, scrollTop: 3000, viewport: 600 })).toBe(300)
  })
})

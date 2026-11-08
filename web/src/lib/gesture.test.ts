import { describe, expect, it } from 'vitest'
import { EDGE_OPEN_BAND, VelocityTracker, clampRubber, followOpen, inEdgeBand, lockAxis, project, rubberband, shouldComplete } from './gesture'

describe('VelocityTracker', () => {
  it('按最近 100ms 的样本计算速度', () => {
    const v = new VelocityTracker()
    v.add(0, 0) // 很早的样本会被丢掉
    v.add(100, 400)
    v.add(150, 450)
    v.add(200, 500)
    expect(v.velocity()).toBeCloseTo(1000) // 100px / 100ms
  })

  it('样本不足时速度为 0', () => {
    const v = new VelocityTracker()
    expect(v.velocity()).toBe(0)
    v.add(10, 0)
    expect(v.velocity()).toBe(0)
  })
})

describe('project', () => {
  it('与 Apple 示例代码一致：1000px/s、0.998 投射约 499px', () => {
    expect(project(1000)).toBeCloseTo(499, 0)
    expect(project(-1000)).toBeCloseTo(-499, 0)
    expect(project(0)).toBe(0)
  })
})

describe('rubberband', () => {
  it('越界越多跟随越少，且永远小于越界距离', () => {
    const a = rubberband(50, 300)
    const b = rubberband(200, 300)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(50)
    expect(b).toBeLessThan(200)
    expect(b - a).toBeLessThan(150)
  })

  it('clampRubber 在范围内原样返回', () => {
    expect(clampRubber(120, 0, 300, 300)).toBe(120)
    expect(clampRubber(-40, 0, 300, 300)).toBeLessThan(0)
    expect(clampRubber(-40, 0, 300, 300)).toBeGreaterThan(-40)
  })
})

describe('shouldComplete', () => {
  it('慢慢拖过一半才完成', () => {
    expect(shouldComplete(150, 0, 375)).toBe(false)
    expect(shouldComplete(200, 0, 375)).toBe(true)
  })

  it('快速轻扫即使只拖了一小段也完成，反向甩回则取消', () => {
    expect(shouldComplete(60, 1500, 375)).toBe(true)
    expect(shouldComplete(250, -1500, 375)).toBe(false)
  })
})

describe('lockAxis', () => {
  it('移动不足时不判定，之后按主方向锁定', () => {
    expect(lockAxis(3, 2)).toBeNull()
    expect(lockAxis(20, 4)).toBe('x')
    expect(lockAxis(8, 20)).toBe('y')
    expect(lockAxis(12, 11)).toBe('y') // 斜着拖时偏向滚动
  })

  it('可以要求横向分量更明显才锁定横向', () => {
    expect(lockAxis(14, 10)).toBe('x')
    expect(lockAxis(14, 10, 10, 1.5)).toBe('y')
    expect(lockAxis(18, 10, 10, 1.5)).toBe('x')
  })
})

describe('inEdgeBand', () => {
  const rect = { left: 0, right: 375 }
  it('右侧：只认靠右缘的窄带', () => {
    expect(inEdgeBand(370, rect, 'right', EDGE_OPEN_BAND)).toBe(true)
    expect(inEdgeBand(375 - EDGE_OPEN_BAND, rect, 'right', EDGE_OPEN_BAND)).toBe(true)
    expect(inEdgeBand(375 - EDGE_OPEN_BAND - 1, rect, 'right', EDGE_OPEN_BAND)).toBe(false)
    expect(inEdgeBand(200, rect, 'right', EDGE_OPEN_BAND)).toBe(false)
  })
  it('左侧对称', () => {
    expect(inEdgeBand(10, rect, 'left', 40)).toBe(true)
    expect(inEdgeBand(41, rect, 'left', 40)).toBe(false)
  })
  it('窄带要宽过 Android 手势导航的返回区（最宽约 40dp），留出系统不占用的部分', () => {
    expect(EDGE_OPEN_BAND).toBeGreaterThan(40)
  })
})

describe('followOpen', () => {
  it('从完全收起开始 1:1 跟手', () => {
    expect(followOpen(300, 0, 300)).toBe(300)
    expect(followOpen(300, 120, 300)).toBe(180)
    expect(followOpen(300, 300, 300)).toBe(0)
  })
  it('从半途接住正在收起的面板：以接住时的位置为起点', () => {
    expect(followOpen(200, 50, 300)).toBe(150)
  })
  it('往回拖超过起点时停在收起位置；拉过完全展开后有阻力', () => {
    expect(followOpen(300, -40, 300)).toBe(300)
    const over = followOpen(300, 360, 300)
    expect(over).toBeLessThan(0)
    expect(over).toBeGreaterThan(-60)
  })
})

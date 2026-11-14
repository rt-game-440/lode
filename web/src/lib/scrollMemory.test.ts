import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('location', { pathname: '/', origin: 'http://127.0.0.1:8787' })
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
})
const { MAX_POSITIONS, getReadPosition, saveReadPosition, skipReadPositionOnce, takeSkipReadPosition } = await import('./scrollMemory')

const pos = (n: number) => ({ topPos: n, offset: 3, head: n + 1 })

describe('浏览位置记忆', () => {
  beforeEach(() => store.clear())

  it('按笔记 id 读写', () => {
    saveReadPosition('default', 'a', pos(10))
    expect(getReadPosition('default', 'a')).toEqual(pos(10))
    expect(getReadPosition('default', 'b')).toBeNull()
    saveReadPosition('default', 'a', pos(20))
    expect(getReadPosition('default', 'a')).toEqual(pos(20))
  })

  it('不同工作空间互不影响，默认空间沿用无后缀的键名', () => {
    saveReadPosition('default', 'a', pos(1))
    saveReadPosition('k3f9a2', 'a', pos(2))
    expect(getReadPosition('default', 'a')).toEqual(pos(1))
    expect(getReadPosition('k3f9a2', 'a')).toEqual(pos(2))
    expect([...store.keys()].sort()).toEqual(['lode.readpos', 'lode.readpos:k3f9a2'])
  })

  it('超过 200 篇时淘汰最早写入的', () => {
    for (let i = 0; i < MAX_POSITIONS + 5; i++) saveReadPosition('default', `n${i}`, pos(i))
    expect(JSON.parse(store.get('lode.readpos')!)).toHaveLength(MAX_POSITIONS)
    expect(getReadPosition('default', 'n0')).toBeNull()
    expect(getReadPosition('default', 'n4')).toBeNull()
    expect(getReadPosition('default', 'n5')).toEqual(pos(5))
    // 重新写入会刷新顺序，不被淘汰
    saveReadPosition('default', 'n5', pos(99))
    saveReadPosition('default', 'extra', pos(1))
    expect(getReadPosition('default', 'n5')).toEqual(pos(99))
    expect(getReadPosition('default', 'n6')).toBeNull()
  })

  it('损坏的存储内容按没有记录处理', () => {
    store.set('lode.readpos', '{bad')
    expect(getReadPosition('default', 'a')).toBeNull()
    store.set('lode.readpos', JSON.stringify([['a', { topPos: 'x' }], 5]))
    expect(getReadPosition('default', 'a')).toBeNull()
  })

  it('带目标位置的入口只跳过一次', () => {
    skipReadPositionOnce('a')
    expect(takeSkipReadPosition('b')).toBe(false)
    expect(takeSkipReadPosition('a')).toBe(true)
    expect(takeSkipReadPosition('a')).toBe(false)
  })
})

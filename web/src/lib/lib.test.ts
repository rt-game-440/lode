import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../api/types'
import { Autosaver, type SaveStatus } from './autosave'
import { fuzzyScore, splitSnippet } from './snippet'
import { buildTree, visibleRows } from './tree'
import { LinkResolver, linkTextFor, parseLinkInner } from './wikilink'

const note = (path: string): Note => ({
  id: path,
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  rev: 1,
  hash: '',
  size: 0,
  mtime: 0,
  created_at: 0,
  updated_at: 0,
})

describe('wikilink', () => {
  it('解析目标、标题与别名', () => {
    expect(parseLinkInner('笔记 A#小节|别名')).toEqual({ target: '笔记 A', heading: '小节', alias: '别名' })
    expect(parseLinkInner('E\\|表格')).toEqual({ target: 'E', heading: '', alias: '表格' })
  })

  it('与后端一致的解析规则：同目录优先、路径最短、路径后缀', () => {
    const r = new LinkResolver(['x/甲.md', 'y/甲.md', 'a/b/深.md', '甲甲.md'])
    expect(r.resolve('甲', 'y/src.md')).toBe('y/甲.md')
    expect(r.resolve('甲', 'src.md')).toBe('x/甲.md')
    expect(r.resolve('b/深', 'src.md')).toBe('a/b/深.md')
    expect(r.resolve('A/B/深.md', 'src.md')).toBe('a/b/深.md')
    expect(r.resolve('不存在', 'src.md')).toBeNull()
  })

  it('插入链接时名称有重复才写路径', () => {
    const all = ['x/甲.md', 'y/甲.md', '乙.md']
    expect(linkTextFor('x/甲.md', all)).toBe('x/甲')
    expect(linkTextFor('乙.md', all)).toBe('乙')
  })
})

describe('tree', () => {
  it('文件夹在前、按中文习惯自然排序（汉字按拼音且排在字母前），并按展开状态生成可见行', () => {
    const root = buildTree(['空', 'b'], [note('b/2.md'), note('b/10.md'), note('a.md'), note('b/c/x.md')])
    expect(root.children.map((c) => c.name)).toEqual(['空', 'b', 'a'])
    const rows = visibleRows(root, new Set(['b']))
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual(['0:空', '0:b', '1:c', '1:2', '1:10', '0:a'])
  })
})

describe('snippet', () => {
  it('拆分高亮标记', () => {
    expect(splitSnippet('前\u0002命中\u0003后')).toEqual([
      { text: '前', hit: false },
      { text: '命中', hit: true },
      { text: '后', hit: false },
    ])
  })

  it('模糊匹配：连续子串优先于零散子序列', () => {
    expect(fuzzyScore('lode', 'lode 笔记')).toBeGreaterThan(fuzzyScore('lode', 'l-o-d-e'))
    expect(fuzzyScore('xyz', 'abc')).toBe(-1)
  })
})

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('停顿 500ms 后保存最新内容，并报告状态', async () => {
    const saved: string[] = []
    const statuses: SaveStatus[] = []
    const a = new Autosaver({
      delay: 500,
      save: async (c) => {
        saved.push(c)
      },
      onStatus: (s) => statuses.push(s),
    })
    a.change('a')
    await vi.advanceTimersByTimeAsync(300)
    a.change('ab')
    await vi.advanceTimersByTimeAsync(499)
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(saved).toEqual(['ab'])
    expect(statuses.at(-1)).toBe('saved')
  })

  it('保存进行中的修改在完成后接着保存，不并发', async () => {
    let resolve!: () => void
    let concurrent = 0
    let maxConcurrent = 0
    const saved: string[] = []
    const a = new Autosaver({
      delay: 500,
      save: (c) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        saved.push(c)
        return new Promise<void>((r) => {
          resolve = () => {
            concurrent--
            r()
          }
        })
      },
      onStatus: () => {},
    })
    a.change('1')
    await vi.advanceTimersByTimeAsync(500)
    a.change('12')
    await vi.advanceTimersByTimeAsync(500)
    expect(saved).toEqual(['1'])
    resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(saved).toEqual(['1', '12'])
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(maxConcurrent).toBe(1)
  })

  it('组字期间推迟保存，失败后保留内容并在 flush 时重试', async () => {
    let composing = true
    let fail = true
    const saved: string[] = []
    const statuses: SaveStatus[] = []
    const a = new Autosaver({
      delay: 500,
      isComposing: () => composing,
      save: async (c) => {
        if (fail) throw new Error('boom')
        saved.push(c)
      },
      onStatus: (s) => statuses.push(s),
    })
    a.change('中')
    await vi.advanceTimersByTimeAsync(2000)
    expect(statuses).not.toContain('saving')
    composing = false
    await vi.advanceTimersByTimeAsync(500)
    expect(statuses.at(-1)).toBe('error')
    fail = false
    await a.flush()
    expect(saved).toEqual(['中'])
    expect(statuses.at(-1)).toBe('saved')
  })
})

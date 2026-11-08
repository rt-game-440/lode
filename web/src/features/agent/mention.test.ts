import { describe, expect, it } from 'vitest'
import type { Note } from '../../api/types'
import { filterNotes, findMention, resolveMentions } from './mention'

const note = (path: string, title: string, mtime: number) => ({ id: path, path, title, mtime }) as unknown as Note

describe('findMention', () => {
  it('行首、空白之后的 @ 是提及，query 是 @ 到光标之间的文字', () => {
    expect(findMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(findMention('看看 @读三', 6)).toEqual({ start: 3, query: '读三' })
  })
  it('@ 与光标之间有空白就结束', () => {
    expect(findMention('@abc def', 8)).toBeNull()
  })
  it('@ 前不是空白（邮箱）不算', () => {
    expect(findMention('a@b', 3)).toBeNull()
  })
  it('光标在 @ 之前不算', () => {
    expect(findMention('@abc', 0)).toBeNull()
  })
})

describe('filterNotes', () => {
  const notes = {
    a: note('读三国.md', '读三国演义有感', 3),
    b: note('日记/今天.md', '今天', 5),
    c: note('日记/昨天.md', '昨天', 1),
  }
  it('按标题或路径过滤，最近修改在前', () => {
    expect(filterNotes(notes, '日记').map((n) => n.title)).toEqual(['今天', '昨天'])
    expect(filterNotes(notes, '三国').map((n) => n.title)).toEqual(['读三国演义有感'])
    expect(filterNotes(notes, '').map((n) => n.title)).toEqual(['今天', '读三国演义有感', '昨天'])
  })
  it('排除已附上的', () => {
    expect(filterNotes(notes, '', ['日记/今天.md']).map((n) => n.title)).toEqual(['读三国演义有感', '昨天'])
  })
})

describe('resolveMentions', () => {
  const base = { contextPath: 'n.md', mentions: [] as string[], suppressed: [] as string[], sent: [] as string[] }
  it('首次发送自动附上当前笔记', () => {
    expect(resolveMentions(base)).toEqual({ all: ['n.md'], auto: true })
  })
  it('用户移除过后不再自动附上', () => {
    expect(resolveMentions({ ...base, suppressed: ['n.md'] })).toEqual({ all: [], auto: false })
  })
  it('之前的消息已经附过就不重复自动附上', () => {
    expect(resolveMentions({ ...base, sent: ['n.md'] })).toEqual({ all: [], auto: false })
  })
  it('用户点“附上当前笔记”后算明确附上，即使之前被移除或发过', () => {
    expect(resolveMentions({ ...base, mentions: ['n.md'], suppressed: ['n.md'], sent: ['n.md'] })).toEqual({ all: ['n.md'], auto: false })
  })
  it('切换到另一篇笔记时重新自动附上', () => {
    expect(resolveMentions({ ...base, contextPath: 'm.md', suppressed: ['n.md'] })).toEqual({ all: ['m.md'], auto: true })
  })
})

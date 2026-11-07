import { describe, expect, it } from 'vitest'
import { diffChangeSet, diffChanges, rebase, toText } from './textdiff'

describe('diffChanges', () => {
  it('应用差异后得到目标文本', () => {
    const cases: [string, string][] = [
      ['', 'abc'],
      ['abc', ''],
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['a\nb\nc', 'x\na\nc\ny'],
      ['第一段\n\n第二段\n', '第一段\n\n新增\n\n第二段\n'],
      ['a\r\nb\r\n', 'a\r\nc\r\n'],
    ]
    for (const [a, b] of cases) {
      expect(diffChangeSet(a, b).apply(toText(a)).toString()).toBe(b)
    }
  })

  it('只标出改动的行', () => {
    expect(diffChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 4, insert: 'B\n' }])
  })
})

describe('rebase', () => {
  const base = '第一段\n\n第二段\n\n第三段\n'
  it('合并两边不重叠的改动', () => {
    const theirs = '第一段 A\n\n第二段\n\n第三段\n'
    const mine = '第一段\n\n第二段\n\n第三段 B\n'
    expect(rebase(base, theirs, mine)).toBe('第一段 A\n\n第二段\n\n第三段 B\n')
  })

  it('一边没改时直接取另一边', () => {
    expect(rebase(base, base, 'x')).toBe('x')
    expect(rebase(base, 'y', base)).toBe('y')
  })

  it('同一位置的插入两边都保留', () => {
    expect(rebase('a\n', 'a\nT\n', 'a\nM\n')).toContain('T\n')
    expect(rebase('a\n', 'a\nT\n', 'a\nM\n')).toContain('M\n')
  })
})

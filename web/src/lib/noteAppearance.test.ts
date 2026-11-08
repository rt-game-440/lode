import { describe, expect, it } from 'vitest'
import { hiddenAppearanceRange, readAppearance, writeAppearance } from './noteAppearance'

describe('笔记外观（front matter 的 lode 键）', () => {
  it('没有 front matter 时是默认值，选非默认值才新建', () => {
    expect(readAppearance('# 标题\n正文')).toEqual({ width: 'standard', font: 'sans' })
    expect(writeAppearance('# 标题\n正文', { width: 'standard', font: 'sans' })).toBe('# 标题\n正文')
    const out = writeAppearance('# 标题\n正文', { width: 'wide' })
    expect(out).toBe('---\nlode:\n  width: wide\n---\n# 标题\n正文')
    expect(readAppearance(out)).toEqual({ width: 'wide', font: 'sans' })
  })

  it('空笔记也能写入，改回默认后恢复为空', () => {
    const out = writeAppearance('', { font: 'mono' })
    expect(out).toBe('---\nlode:\n  font: mono\n---\n')
    expect(writeAppearance(out, { font: 'sans' })).toBe('')
  })

  it('改回默认时删除对应键，键全部删除后不留空的 front matter', () => {
    let t = writeAppearance('正文', { width: 'narrow', font: 'serif' })
    expect(t).toBe('---\nlode:\n  width: narrow\n  font: serif\n---\n正文')
    t = writeAppearance(t, { width: 'standard' })
    expect(t).toBe('---\nlode:\n  font: serif\n---\n正文')
    t = writeAppearance(t, { font: 'sans' })
    expect(t).toBe('正文')
  })

  it('保留其余 front matter 原样不动（顺序、注释、引号、列表）', () => {
    const src = "---\ntitle: '读书笔记'  # 注释\ntags:\n  - 读书\n  - 历史\nlode:\n  font: serif\ncreated: 2026-11-08\n---\n\n# 三国\n"
    const out = writeAppearance(src, { width: 'wide' })
    expect(out).toBe(
      "---\ntitle: '读书笔记'  # 注释\ntags:\n  - 读书\n  - 历史\nlode:\n  font: serif\n  width: wide\ncreated: 2026-11-08\n---\n\n# 三国\n",
    )
    const back = writeAppearance(writeAppearance(out, { width: 'standard' }), { font: 'sans' })
    expect(back).toBe("---\ntitle: '读书笔记'  # 注释\ntags:\n  - 读书\n  - 历史\ncreated: 2026-11-08\n---\n\n# 三国\n")
  })

  it('已有 front matter 但没有 lode 时追加在末尾', () => {
    const out = writeAppearance('---\ntags: [写作]\n---\n正文', { font: 'serif' })
    expect(out).toBe('---\ntags: [写作]\nlode:\n  font: serif\n---\n正文')
    expect(writeAppearance(out, { font: 'sans' })).toBe('---\ntags: [写作]\n---\n正文')
  })

  it('读取行内写法、带引号的值，并沿用原有写法和缩进', () => {
    const flow = '---\nlode: {width: "narrow", font: mono}\n---\n正文'
    expect(readAppearance(flow)).toEqual({ width: 'narrow', font: 'mono' })
    expect(writeAppearance(flow, { width: 'wide' })).toBe('---\nlode: {width: wide, font: mono}\n---\n正文')
    expect(writeAppearance(flow, { width: 'standard', font: 'sans' })).toBe('正文')
    const tab = '---\nlode:\n    font: serif\n---\n'
    expect(writeAppearance(tab, { width: 'wide' })).toBe('---\nlode:\n    font: serif\n    width: wide\n---\n')
  })

  it('认不出的值按默认处理，认不出的子键原样保留', () => {
    const src = '---\nlode:\n  width: huge\n  theme: sepia\n---\n'
    expect(readAppearance(src)).toEqual({ width: 'standard', font: 'sans' })
    expect(writeAppearance(src, { font: 'serif' })).toBe('---\nlode:\n  width: huge\n  theme: sepia\n  font: serif\n---\n')
    // width 的值认不出，写入默认值时也删掉这一行；theme 留着
    expect(writeAppearance(src, { width: 'standard' })).toBe('---\nlode:\n  theme: sepia\n---\n')
  })

  it('保留 CRLF 换行', () => {
    const src = '---\r\ntags: [a]\r\n---\r\n正文\r\n'
    expect(writeAppearance(src, { font: 'serif' })).toBe('---\r\ntags: [a]\r\nlode:\r\n  font: serif\r\n---\r\n正文\r\n')
    expect(writeAppearance('正文\r\n', { font: 'mono' })).toBe('---\r\nlode:\r\n  font: mono\r\n---\r\n正文\r\n')
  })

  it('开头的分隔线不是 front matter，新建的 front matter 放在它前面', () => {
    const src = '---\n\n正文\n---\n'
    expect(readAppearance(src)).toEqual({ width: 'standard', font: 'sans' })
    expect(writeAppearance(src, { font: 'serif' })).toBe('---\nlode:\n  font: serif\n---\n---\n\n正文\n---\n')
  })

  it('lode 写在别的键的缩进里时不算', () => {
    const src = '---\nmeta:\n  lode: x\n---\n'
    expect(readAppearance(src)).toEqual({ width: 'standard', font: 'sans' })
  })

  it('编辑器里藏起 lode：只有 lode 时整块，有别的键时只藏 lode 几行', () => {
    const only = '---\nlode:\n  font: serif\n---\n正文'
    expect(hiddenAppearanceRange(only)).toEqual({ from: 0, to: only.indexOf('\n正文'), whole: true })
    const mixed = '---\ntags: [a]\nlode:\n  font: serif\n---\n正文'
    const from = mixed.indexOf('lode:')
    expect(hiddenAppearanceRange(mixed)).toEqual({ from, to: mixed.indexOf('\n---\n正文'), whole: false })
    expect(hiddenAppearanceRange('---\ntags: [a]\n---\n')).toBeNull()
    // 后面没有下一行时不藏（光标没有地方停）
    expect(hiddenAppearanceRange('---\nlode:\n  font: serif\n---')).toBeNull()
  })
})

import { GFM, parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { type TableModel, modelKey, parseAligns, parseTable } from './tableModel'
import { wikiLinkSyntax } from './wikilinkSyntax'

const md = parser.configure([GFM, wikiLinkSyntax])
const BS = String.fromCharCode(92)

/** 解析文本里所有顶层表格。 */
function tables(src: string): TableModel[] {
  const out: TableModel[] = []
  const tree = md.parse(src)
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'Table') {
      const m = parseTable(src, c)
      if (m) out.push(m)
    }
  }
  return out
}

describe('parseAligns', () => {
  it('解析左、中、右和默认对齐', () => {
    expect(parseAligns('|:--|:-:|--:|---|')).toEqual(['left', 'center', 'right', null])
  })
  it('没有首尾竖线也能解析', () => {
    expect(parseAligns(' :-: | --- ')).toEqual(['center', null])
  })
})

describe('parseTable', () => {
  it('解析用户笔记里的表格：表头、行数、加粗', () => {
    const src = ['| 顺序 | 内容 | 对应章节 |', '|---|---|---|', '| 1 | 零基础入门：电厂 | 第一章 |', '| 2 | **必背数字一页纸** | 第二章 |', '| 3 | 岗位 7 项职责 ↔ 具体怎么做 | 第七章 |'].join('\n')
    const [t] = tables(src)
    expect(t.head.map((c) => c.content)).toEqual([[{ t: 'text', s: '顺序' }], [{ t: 'text', s: '内容' }], [{ t: 'text', s: '对应章节' }]])
    expect(t.rows).toHaveLength(3)
    expect(t.rows[1][1].content).toEqual([{ t: 'strong', c: [{ t: 'text', s: '必背数字一页纸' }] }])
    expect(t.rows[2][1].content).toEqual([{ t: 'text', s: '岗位 7 项职责 ↔ 具体怎么做' }])
    expect(t.aligns).toEqual([null, null, null])
  })

  it('单元格位置对应原文', () => {
    const src = '| a | bb |\n|---|---|\n| c | dd |'
    const [t] = tables(src)
    expect(src.slice(t.head[1].from, t.head[1].to)).toBe('bb')
    expect(src.slice(t.rows[0][1].from, t.rows[0][1].to)).toBe('dd')
    expect([t.from, t.to]).toEqual([0, src.length])
  })

  it('列数不齐：不足补空，多出丢弃', () => {
    const src = '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'
    const [t] = tables(src)
    expect(t.rows.map((r) => r.length)).toEqual([2, 2])
    expect(t.rows[0][1].content).toEqual([])
  })

  it('对齐写进模型', () => {
    const [t] = tables('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(t.aligns).toEqual(['left', 'center', 'right'])
  })

  it('单元格里的行内元素', () => {
    const src = [
      '| 列 | 值 |',
      '|---|---|',
      '| `代码` | [文字](https://a.b/c) |',
      '| [[目标#节|别名]] | #标签 |',
      '| ![[图.png]] | ~~删~~ *斜* |',
    ].join('\n')
    // [[目标#节|别名]] 里的竖线要写成转义才不会拆列
    const fixed = src.replace('[[目标#节|别名]]', `[[目标#节${BS}|别名]]`)
    const [t] = tables(fixed)
    expect(t.rows[0][0].content).toEqual([{ t: 'code', s: '代码' }])
    expect(t.rows[0][1].content).toEqual([{ t: 'link', href: 'https://a.b/c', c: [{ t: 'text', s: '文字' }] }])
    expect(t.rows[1][0].content).toEqual([{ t: 'wikilink', target: '目标', heading: '节', label: '别名' }])
    expect(t.rows[1][1].content).toEqual([{ t: 'tag', tag: '标签', s: '#标签' }])
    expect(t.rows[2][0].content).toEqual([{ t: 'embed', target: '图.png', alias: '' }])
    expect(t.rows[2][1].content).toEqual([
      { t: 'del', c: [{ t: 'text', s: '删' }] },
      { t: 'text', s: ' ' },
      { t: 'em', c: [{ t: 'text', s: '斜' }] },
    ])
  })

  it('转义的竖线留在单元格里并去掉反斜杠', () => {
    const [t] = tables(`| a | b |\n|---|---|\n| x ${BS}| y | z |`)
    expect(t.rows[0]).toHaveLength(2)
    expect(t.rows[0][0].content.map((i) => (i.t === 'text' ? i.s : '')).join('')).toBe('x | y')
  })

  it('图片语法', () => {
    const [t] = tables('| a |\n|---|\n| ![说明](attachments/x.png) |')
    expect(t.rows[0][0].content).toEqual([{ t: 'image', src: 'attachments/x.png', alt: '说明' }])
  })

  it('没有分隔行就不是表格', () => {
    expect(tables('| a | b |\n| 1 | 2 |')).toEqual([])
  })
})

describe('modelKey', () => {
  it('表格上方插入文字后位置整体平移，key 不变；内容变化 key 才变', () => {
    const body = '| a | b |\n|---|---|\n| 1 | 2 |'
    const [a] = tables(body)
    const [b] = tables(`前言\n\n${body}`)
    const [c] = tables(body.replace('2', '3'))
    expect(modelKey(a)).toBe(modelKey(b))
    expect(modelKey(a)).not.toBe(modelKey(c))
  })
})

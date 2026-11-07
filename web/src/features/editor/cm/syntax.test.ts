import { parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { wikiLinkSyntax } from './wikilinkSyntax'

const md = parser.configure([wikiLinkSyntax])

/** 列出指定类型节点覆盖的原文。 */
function nodes(text: string, name: string): string[] {
  const out: string[] = []
  md.parse(text).iterate({
    enter: (n) => {
      if (n.name === name) out.push(text.slice(n.from, n.to))
    },
  })
  return out
}

describe('wikilink 语法扩展', () => {
  it('解析 wikilink、嵌入和别名', () => {
    const text = '见 [[目标笔记#小节|别名]] 和 ![[attachments/图.png]]，[[ ]] 不算'
    expect(nodes(text, 'WikiLink')).toEqual(['[[目标笔记#小节|别名]]'])
    expect(nodes(text, 'WikiEmbed')).toEqual(['![[attachments/图.png]]'])
  })

  it('标签规则与后端一致：需要边界、不能是纯数字、标题符号不算', () => {
    const text = '# 标题\n\n写作 #灵感，(#项目/lode) a#b #123 `#代码` #v2'
    expect(nodes(text, 'HashTag')).toEqual(['#灵感', '#项目/lode', '#v2'])
  })

  it('文档开头的 YAML 是 frontmatter，不再被当成标题或分隔线', () => {
    const text = '---\ntags: [写作]\n---\n正文'
    expect(nodes(text, 'Frontmatter')).toEqual(['---\ntags: [写作]\n---'])
    expect(nodes(text, 'SetextHeading2')).toEqual([])
    expect(nodes(text, 'HorizontalRule')).toEqual([])
  })

  it('开头的普通分隔线不是 frontmatter', () => {
    const text = '---\n\n正文'
    expect(nodes(text, 'Frontmatter')).toEqual([])
    expect(nodes(text, 'HorizontalRule')).toEqual(['---'])
  })
})

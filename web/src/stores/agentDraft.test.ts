import { describe, expect, it } from 'vitest'
import { quoteMarkdown, splitQuote, withQuote } from './agentDraft'

describe('引用片段（#73）', () => {
  it('每行加 > ，空行保留为 >，去掉首尾空行', () => {
    expect(quoteMarkdown('\n第一行\n\n第二行\n')).toBe('> 第一行\n>\n> 第二行')
  })

  it('发送的正文：引用在前，空一行接用户的话', () => {
    expect(withQuote('原文', '解释一下')).toBe('> 原文\n\n解释一下')
    expect(withQuote(null, '解释一下')).toBe('解释一下')
    expect(withQuote('原文', '')).toBe('> 原文')
  })

  it('消息气泡把开头的引用拆出来', () => {
    expect(splitQuote('> 第一行\n>\n> 第二行\n\n解释一下')).toEqual({ quote: '第一行\n\n第二行', body: '解释一下' })
    expect(splitQuote('没有引用')).toEqual({ quote: null, body: '没有引用' })
    expect(splitQuote('>不是引用')).toEqual({ quote: null, body: '>不是引用' })
  })
})

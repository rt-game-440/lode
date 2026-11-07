import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} />)

describe('Markdown', () => {
  it('渲染常见块级和行内语法', () => {
    const out = html('# 标题\n\n一段**加粗**和*斜体*，`代码` 与 ~~删除~~。\n\n- 甲\n- [x] 乙\n\n1. 一\n2. 二\n\n> 引用')
    expect(out).toContain('<h1>标题</h1>')
    expect(out).toContain('<strong>加粗</strong>')
    expect(out).toContain('<em>斜体</em>')
    expect(out).toContain('<code>代码</code>')
    expect(out).toContain('<del>删除</del>')
    expect(out).toContain('<ul><li>甲</li>')
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>乙/)
    expect(out).toContain('<ol><li>一</li><li>二</li></ol>')
    expect(out).toContain('<blockquote><p>引用</p></blockquote>')
  })

  it('代码块保留原文并标注语言', () => {
    const out = html('```go\nfmt.Println("<b>")\n```')
    expect(out).toContain('<pre data-lang="go"><code>fmt.Println(&quot;&lt;b&gt;&quot;)</code></pre>')
  })

  it('流式输出中未闭合的代码块也能显示', () => {
    expect(html('看这里：\n\n```js\nconst a = 1')).toContain('<code>const a = 1</code>')
  })

  it('表格', () => {
    const out = html('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |')
    expect(out).toContain('<table><thead><tr><th>名称</th><th>数量</th></tr></thead><tbody><tr><td>苹果</td><td>3</td></tr></tbody></table>')
  })

  it('只允许 http、https、mailto 链接，HTML 原样显示为文本', () => {
    const out = html('[官网](https://example.com) [坏](javascript:alert(1)) <script>alert(1)</script>')
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">官网</a>')
    expect(out).not.toContain('href="javascript')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('双链渲染成可点击的笔记链接', () => {
    expect(html('见 [[周报/第 45 周|上周周报]]')).toContain('<button type="button" class="md-wikilink" data-target="周报/第 45 周">上周周报</button>')
  })
})

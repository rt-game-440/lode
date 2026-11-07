import { tags as t } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'

const BRACKET = 91 // [
const BANG = 33 // !
const HASH = 35 // #

/** 标签前允许出现的字符，与后端 mdparse.tagBoundary 一致。 */
const TAG_BOUNDARY = /[\s([{（【「，,。；;：:、“‘"']/
/** 标签字符，与后端 mdparse.isTagRune 一致。 */
const TAG_BODY = /^[\p{L}\p{Nd}\p{Mn}_\-/]+/u
const YAML_KEY = /^[\p{L}\p{N}_\-]+\s*:/u

/**
 * Lezer Markdown 扩展：
 * - [[目标#标题|别名]] 解析为 WikiLink，![[...]] 解析为 WikiEmbed，子节点 WikiLinkMark 是两端的括号；
 * - 正文里的 #标签 解析为 HashTag；
 * - 文档开头 --- 包围的 YAML 解析为 Frontmatter。
 */
export const wikiLinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: t.link },
    { name: 'WikiEmbed', style: t.link },
    { name: 'WikiLinkMark', style: t.processingInstruction },
    { name: 'HashTag', style: t.labelName },
    { name: 'Frontmatter', block: true, style: t.meta },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false
        // 下一行像 YAML 键或直接结束时才当作 frontmatter，避免把开头的分隔线误判
        const next = cx.peekLine()
        if (!YAML_KEY.test(next) && !/^---\s*$/.test(next)) return false
        const from = cx.lineStart
        let to = from + line.text.length
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('Frontmatter', from, to))
        return true
      },
    },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        let open = pos
        let embed = false
        if (next === BANG) {
          if (cx.char(pos + 1) !== BRACKET || cx.char(pos + 2) !== BRACKET) return -1
          embed = true
          open = pos + 1
        } else if (next !== BRACKET || cx.char(pos + 1) !== BRACKET) {
          return -1
        }
        const rest = cx.slice(open + 2, cx.end)
        const close = rest.indexOf(']]')
        if (close <= 0) return -1
        const inner = rest.slice(0, close)
        if (inner.includes('\n') || inner.includes('[[') || !inner.trim()) return -1
        const end = open + 2 + close + 2
        return cx.addElement(
          cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, end, [
            cx.elt('WikiLinkMark', pos, open + 2),
            cx.elt('WikiLinkMark', end - 2, end),
          ]),
        )
      },
    },
    {
      name: 'HashTag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1
        if (pos > cx.offset) {
          const prev = String.fromCharCode(cx.char(pos - 1))
          if (!TAG_BOUNDARY.test(prev)) return -1
        }
        const m = TAG_BODY.exec(cx.slice(pos + 1, Math.min(cx.end, pos + 201)))
        if (!m) return -1
        const body = m[0].replace(/^\/+|\/+$/g, '')
        if (!body || /^\p{Nd}+$/u.test(body)) return -1
        return cx.addElement(cx.elt('HashTag', pos, pos + 1 + m[0].length))
      },
    },
  ],
}

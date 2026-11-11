// 把 Lezer 的 Table 节点转成与 DOM 无关的模型，供编辑器里的表格预览使用。纯函数，便于单测。
import type { parser } from '@lezer/markdown'
import { parseLinkInner } from '../../../lib/wikilink'

/** Lezer 的语法节点（@lezer/common 不是直接依赖，从解析器类型取）。 */
export type SyntaxNode = ReturnType<typeof parser.parse>['topNode']

export type Align = 'left' | 'center' | 'right' | null

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; s: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'wikilink'; target: string; heading: string; label: string }
  | { t: 'embed'; target: string; alias: string }
  | { t: 'image'; src: string; alt: string }
  | { t: 'tag'; tag: string; s: string }
  | { t: 'br' }

export interface Cell {
  /** 单元格在文档里的位置，点击渲染后的单元格时据此定位光标 */
  from: number
  to: number
  content: Inline[]
}

export interface TableModel {
  from: number
  to: number
  aligns: Align[]
  head: Cell[]
  rows: Cell[][]
}

/** 不输出内容的标记节点。 */
const MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'LinkTitle', 'LinkLabel', 'WikiLinkMark', 'TableDelimiter'])

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c
  return null
}

/** 依次输出子节点，子节点之间的原文作为文本。 */
function inlineChildren(src: string, node: SyntaxNode, from = node.from, to = node.to): Inline[] {
  const out: Inline[] = []
  const text = (a: number, b: number) => {
    if (b > a) out.push({ t: 'text', s: src.slice(a, b) })
  }
  let pos = from
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue
    text(pos, c.from)
    if (!MARKS.has(c.name)) out.push(...inline(src, c))
    pos = c.to
  }
  text(pos, to)
  return out
}

function inline(src: string, node: SyntaxNode): Inline[] {
  switch (node.name) {
    case 'StrongEmphasis':
      return [{ t: 'strong', c: inlineChildren(src, node) }]
    case 'Emphasis':
      return [{ t: 'em', c: inlineChildren(src, node) }]
    case 'Strikethrough':
      return [{ t: 'del', c: inlineChildren(src, node) }]
    case 'InlineCode': {
      const marks: SyntaxNode[] = []
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') marks.push(c)
      const s = marks.length >= 2 ? src.slice(marks[0].to, marks[marks.length - 1].from) : src.slice(node.from, node.to)
      return [{ t: 'code', s }]
    }
    case 'Link': {
      const marks: SyntaxNode[] = []
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c)
      const url = child(node, 'URL')
      // 只有 [文字] 没有地址时按普通文本
      if (marks.length < 2 || (!url && !child(node, 'LinkLabel'))) return [{ t: 'text', s: src.slice(node.from, node.to) }]
      const href = url ? src.slice(url.from, url.to) : ''
      return [{ t: 'link', href, c: inlineChildren(src, node, marks[0].to, marks[1].from) }]
    }
    case 'Image': {
      const url = child(node, 'URL')
      if (!url) return [{ t: 'text', s: src.slice(node.from, node.to) }]
      const alt = /^!\[([^\]]*)\]/.exec(src.slice(node.from, node.to))?.[1] ?? ''
      return [{ t: 'image', src: src.slice(url.from, url.to).replace(/^<|>$/g, ''), alt }]
    }
    case 'URL':
      return node.parent?.name === 'Link' || node.parent?.name === 'Image'
        ? []
        : [{ t: 'link', href: src.slice(node.from, node.to), c: [{ t: 'text', s: src.slice(node.from, node.to) }] }]
    case 'WikiLink':
    case 'WikiEmbed': {
      const embed = node.name === 'WikiEmbed'
      const inner = src.slice(node.from + (embed ? 3 : 2), node.to - 2)
      const link = parseLinkInner(inner)
      return embed
        ? [{ t: 'embed', target: link.target, alias: link.alias }]
        : [{ t: 'wikilink', target: link.target, heading: link.heading, label: link.alias || link.target }]
    }
    case 'HashTag': {
      const s = src.slice(node.from, node.to)
      return [{ t: 'tag', tag: s.slice(1).replace(/^\/+|\/+$/g, '').toLowerCase(), s }]
    }
    case 'Escape':
      return [{ t: 'text', s: src.slice(node.from + 1, node.to) }]
    case 'HardBreak':
      return [{ t: 'br' }]
    default:
      // HTMLTag、Entity 等：显示原文
      return node.firstChild ? inlineChildren(src, node) : [{ t: 'text', s: src.slice(node.from, node.to) }]
  }
}

function cells(src: string, row: SyntaxNode): Cell[] {
  const out: Cell[] = []
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableCell') out.push({ from: c.from, to: c.to, content: inlineChildren(src, c) })
  }
  return out
}

/** 分隔行（|:--|:-:|--:|）解析出每列的对齐方式。 */
export function parseAligns(delimiterRow: string): Align[] {
  const inner = delimiterRow.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((s) => {
    const t = s.trim()
    const l = t.startsWith(':')
    const r = t.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null
  })
}

/** 表格节点 → 模型；列数以表头为准，行内不足的补空单元格、多出的丢弃（与 GFM 一致）。 */
export function parseTable(src: string, table: SyntaxNode): TableModel | null {
  const header = child(table, 'TableHeader')
  if (!header) return null
  let delim: SyntaxNode | null = null
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter' && c.to - c.from > 1) delim = c
  }
  const head = cells(src, header)
  const cols = head.length
  const aligns = delim ? parseAligns(src.slice(delim.from, delim.to)) : []
  while (aligns.length < cols) aligns.push(null)
  aligns.length = cols

  const rows: Cell[][] = []
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'TableRow') continue
    const row = cells(src, c).slice(0, cols)
    while (row.length < cols) row.push({ from: c.to, to: c.to, content: [] })
    rows.push(row)
  }
  return { from: table.from, to: table.to, aligns, head, rows }
}

/** 用于 widget.eq：模型内容相同就不重建 DOM。单元格位置用相对表格起点的偏移，表格上方改动时不会让 key 变化。 */
export function modelKey(m: TableModel): string {
  const rel = (cs: Cell[]) => cs.map((c) => [c.from - m.from, c.to - m.from, c.content])
  return JSON.stringify([m.aligns, rel(m.head), m.rows.map(rel)])
}

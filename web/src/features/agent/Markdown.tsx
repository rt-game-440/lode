import { GFM, parser as baseParser } from '@lezer/markdown'
import { type ReactNode, memo } from 'react'
import { fileUrl } from '../../api/client'
import { parseLinkInner } from '../../lib/wikilink'
import { wikiLinkSyntax } from '../editor/cm/wikilinkSyntax'

// 助手回复的 Markdown 渲染：用编辑器同一套 Lezer 解析器得到语法树，再逐个节点生成 React 元素。
// 不经过 innerHTML，原始 HTML 一律当文本显示；链接只放行 http、https、mailto。
// 流式输出时每次增量都重新解析整段文本，未闭合的代码块等也能正常显示。

const parser = baseParser.configure([GFM, wikiLinkSyntax])

/** Lezer 的语法节点（@lezer/common 不是直接依赖，从解析结果取类型）。 */
type SyntaxNode = ReturnType<typeof parser.parse>['topNode']

/** 不输出内容的标记节点。 */
const MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'QuoteMark',
  'ListMark',
  'StrikethroughMark',
  'TableDelimiter',
  'TaskMarker',
  'WikiLinkMark',
  'LinkTitle',
  'LinkLabel',
])

const SAFE_URL = /^(https?:|mailto:)/i

interface Ctx {
  src: string
  onWikiLink?: (target: string) => void
}

function text(ctx: Ctx, from: number, to: number) {
  return ctx.src.slice(from, to)
}

/** 依次输出子节点，子节点之间的原文作为文本；block 为真时丢弃块之间的空白。 */
function children(ctx: Ctx, node: SyntaxNode, from = node.from, to = node.to, block = false): ReactNode[] {
  const out: ReactNode[] = []
  let pos = from
  let key = 0
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue
    if (c.from > pos) {
      const gap = text(ctx, pos, c.from)
      if (!block || gap.trim()) out.push(gap)
    }
    if (!MARKS.has(c.name)) out.push(<Node key={key++} ctx={ctx} node={c} />)
    pos = c.to
  }
  if (pos < to) {
    const gap = text(ctx, pos, to)
    if (!block || gap.trim()) out.push(gap)
  }
  return out
}

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c
  return null
}

function codeText(ctx: Ctx, node: SyntaxNode): string {
  let s = ''
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeText') s += text(ctx, c.from, c.to)
  return s
}

function link(ctx: Ctx, node: SyntaxNode, image: boolean): ReactNode {
  const marks: SyntaxNode[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c)
  const url = child(node, 'URL')
  const href = url ? text(ctx, url.from, url.to) : ''
  const label = marks.length >= 2 ? children(ctx, node, marks[0].to, marks[1].from) : text(ctx, node.from, node.to)
  if (image) {
    // 只显示 vault 内的图片，不加载外部地址
    if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) {
      const alt = marks.length >= 2 ? text(ctx, marks[0].to, marks[1].from) : ''
      return <img src={fileUrl(decodeURI(href.replace(/^\/+/, '')))} alt={alt} loading="lazy" />
    }
    return SAFE_URL.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      text(ctx, node.from, node.to)
    )
  }
  if (!SAFE_URL.test(href)) return <>{label}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  )
}

function table(ctx: Ctx, node: SyntaxNode): ReactNode {
  const rows: SyntaxNode[] = []
  let head: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader') head = c
    else if (c.name === 'TableRow') rows.push(c)
  }
  const cells = (row: SyntaxNode, Tag: 'th' | 'td') => {
    const out: ReactNode[] = []
    for (let c = row.firstChild; c; c = c.nextSibling)
      if (c.name === 'TableCell') out.push(<Tag key={c.from}>{children(ctx, c)}</Tag>)
    return out
  }
  return (
    <div className="md-table">
      <table>
        {head && (
          <thead>
            <tr>{cells(head, 'th')}</tr>
          </thead>
        )}
        <tbody>
          {rows.map((r) => (
            <tr key={r.from}>{cells(r, 'td')}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Node({ ctx, node }: { ctx: Ctx; node: SyntaxNode }): ReactNode {
  switch (node.name) {
    case 'Paragraph':
      return <p>{children(ctx, node)}</p>
    case 'ATXHeading1':
    case 'SetextHeading1':
      return <h1>{children(ctx, node).map(trimEdge)}</h1>
    case 'ATXHeading2':
    case 'SetextHeading2':
      return <h2>{children(ctx, node).map(trimEdge)}</h2>
    case 'ATXHeading3':
      return <h3>{children(ctx, node).map(trimEdge)}</h3>
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
      return <h4>{children(ctx, node).map(trimEdge)}</h4>
    case 'BulletList':
      return <ul>{children(ctx, node, node.from, node.to, true)}</ul>
    case 'OrderedList': {
      const first = node.firstChild?.firstChild
      const start = first?.name === 'ListMark' ? parseInt(text(ctx, first.from, first.to), 10) : 1
      return <ol start={start !== 1 && Number.isFinite(start) ? start : undefined}>{children(ctx, node, node.from, node.to, true)}</ol>
    }
    case 'ListItem':
      return <li>{listItem(ctx, node)}</li>
    case 'Task': {
      const marker = child(node, 'TaskMarker')
      const checked = marker ? /x/i.test(text(ctx, marker.from, marker.to)) : false
      return (
        <>
          <input type="checkbox" disabled checked={checked} readOnly />
          {children(ctx, node, marker ? marker.to : node.from).map(trimStart)}
        </>
      )
    }
    case 'Blockquote':
      return <blockquote>{children(ctx, node, node.from, node.to, true)}</blockquote>
    case 'FencedCode': {
      const info = child(node, 'CodeInfo')
      const lang = info ? text(ctx, info.from, info.to).trim() : undefined
      return (
        <pre data-lang={lang || undefined}>
          <code>{codeText(ctx, node)}</code>
        </pre>
      )
    }
    case 'CodeBlock':
      return (
        <pre>
          <code>{text(ctx, node.from, node.to).replace(/^ {4}/gm, '')}</code>
        </pre>
      )
    case 'Frontmatter':
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock':
      return <pre>{text(ctx, node.from, node.to)}</pre>
    case 'HorizontalRule':
      return <hr />
    case 'Table':
      return table(ctx, node)
    case 'Emphasis':
      return <em>{children(ctx, node)}</em>
    case 'StrongEmphasis':
      return <strong>{children(ctx, node)}</strong>
    case 'Strikethrough':
      return <del>{children(ctx, node)}</del>
    case 'InlineCode': {
      const marks: SyntaxNode[] = []
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') marks.push(c)
      const inner = marks.length >= 2 ? text(ctx, marks[0].to, marks[marks.length - 1].from) : text(ctx, node.from, node.to)
      return <code>{inner}</code>
    }
    case 'Link':
      return link(ctx, node, false)
    case 'Image':
      return link(ctx, node, true)
    case 'Autolink':
    case 'URL': {
      const url = node.name === 'URL' ? node : child(node, 'URL')
      const href = url ? text(ctx, url.from, url.to) : ''
      const shown = /^www\./i.test(href) ? `https://${href}` : href
      return SAFE_URL.test(shown) ? (
        <a href={shown} target="_blank" rel="noopener noreferrer">
          {href}
        </a>
      ) : (
        text(ctx, node.from, node.to)
      )
    }
    case 'WikiLink':
    case 'WikiEmbed': {
      const inner = text(ctx, node.from, node.to).replace(/^!?\[\[/, '').replace(/\]\]$/, '')
      const { target, alias } = parseLinkInner(inner)
      return (
        <button type="button" className="md-wikilink" data-target={target} onClick={() => ctx.onWikiLink?.(target)}>
          {alias || inner.split('|')[0]}
        </button>
      )
    }
    case 'HardBreak':
      return <br />
    case 'Escape':
      return text(ctx, node.from + 1, node.to)
    default:
      // HTMLTag、Entity、HashTag 等：显示原文
      return node.firstChild ? <>{children(ctx, node)}</> : text(ctx, node.from, node.to)
  }
}

/** 列表项里只有一个段落时去掉段落，紧凑显示。 */
function listItem(ctx: Ctx, node: SyntaxNode): ReactNode[] {
  let paragraphs = 0
  let others = 0
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'Paragraph') paragraphs++
    else if (!MARKS.has(c.name)) others++
  }
  if (paragraphs === 1) {
    const out: ReactNode[] = []
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (MARKS.has(c.name)) continue
      out.push(c.name === 'Paragraph' ? <span key={c.from}>{children(ctx, c)}</span> : <Node key={c.from} ctx={ctx} node={c} />)
    }
    // 只有一个段落时不包 span，输出更干净
    return others === 0 ? children(ctx, node.getChild('Paragraph')!) : out
  }
  return children(ctx, node, node.from, node.to, true)
}

function trimEdge(n: ReactNode, i: number, all: ReactNode[]): ReactNode {
  if (typeof n !== 'string') return n
  let s = n
  if (i === 0) s = s.trimStart()
  if (i === all.length - 1) s = s.replace(/\s*#*\s*$/, '')
  return s
}

function trimStart(n: ReactNode, i: number): ReactNode {
  return i === 0 && typeof n === 'string' ? n.trimStart() : n
}

export const Markdown = memo(function Markdown({ source, onWikiLink }: { source: string; onWikiLink?: (target: string) => void }) {
  const tree = parser.parse(source)
  const ctx: Ctx = { src: source, onWikiLink }
  return <div className="md">{children(ctx, tree.topNode, 0, source.length, true)}</div>
})

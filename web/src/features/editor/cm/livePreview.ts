import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, RangeSet, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { fileUrl } from '../../../api/client'
import { dirname, join } from '../../../lib/paths'
import { parseLinkInner } from '../../../lib/wikilink'

/** 编辑器外部提供的上下文：链接是否存在、当前笔记路径。 */
export interface PreviewContext {
  notePath: () => string
  linkExists: (target: string, srcPath: string) => boolean
}

/** 链接索引变化（笔记增删改名）时派发，让装饰重新计算。 */
export const refreshPreview = StateEffect.define<null>()

const hidden = Decoration.replace({})

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super()
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM() {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    box.dataset.pos = String(this.pos)
    box.setAttribute('aria-label', this.checked ? '已完成任务' : '未完成任务')
    return box
  }
  ignoreEvent() {
    return false
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-bullet'
    s.textContent = '•'
    return s
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-hr'
    return s
  }
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

export class ImageWidget extends WidgetType {
  constructor(
    readonly sources: string[],
    readonly alt: string,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.alt === this.alt && o.sources.join('\n') === this.sources.join('\n')
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const img = document.createElement('img')
    img.alt = this.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    let i = 0
    img.src = this.sources[0]
    img.onerror = () => {
      i++
      if (i < this.sources.length) img.src = this.sources[i]
      else wrap.classList.add('cm-image-broken')
    }
    wrap.appendChild(img)
    return wrap
  }
  get estimatedHeight() {
    return 200
  }
}

/** 嵌入目标对应的候选 URL：带目录的按 vault 路径，否则依次尝试笔记同目录、根目录和 attachments/。 */
export function embedSources(target: string, notePath: string): string[] {
  const t = target.replace(/^\.?\//, '')
  if (t.includes('/')) return [fileUrl(t)]
  const dir = dirname(notePath)
  const list = [join(dir, t), t, join('attachments', t)]
  return [...new Set(list)].map(fileUrl)
}

export function imageSources(url: string, notePath: string): string[] {
  if (/^(https?:|data:|blob:)/i.test(url)) return [url]
  let u = url
  try {
    u = decodeURI(url)
  } catch {
    /* 保留原样 */
  }
  if (u.startsWith('/')) return [fileUrl(u.slice(1))]
  return embedSources(u, notePath)
}

/** 选区覆盖的行号集合：这些行显示原始 Markdown 标记。 */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) lines.add(n)
  }
  return lines
}

function build(view: EditorView, ctx: PreviewContext): DecorationSet {
  const { state } = view
  const doc = state.doc
  const active = activeLines(state)
  const focused = view.hasFocus
  const isActive = (pos: number) => focused && active.has(doc.lineAt(pos).number)
  const deco: Range<Decoration>[] = []
  const notePath = ctx.notePath()

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        // 标题：整行加样式，非活动行隐藏 # 与后面的空格
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          const line = doc.lineAt(node.from)
          deco.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(line.from))
          return
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent
          if (parent && /^SetextHeading/.test(parent.name)) return
          if (isActive(node.from)) return
          let end = node.to
          if (doc.sliceString(end, end + 1) === ' ') end++
          // 结尾的 # 也隐藏
          deco.push(hidden.range(node.from, end))
          return
        }
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          if (!isActive(node.from)) deco.push(hidden.range(node.from, node.to))
          return
        }
        if (name === 'InlineCode') {
          deco.push(Decoration.mark({ class: 'cm-inline-code' }).range(node.from, node.to))
          if (!isActive(node.from)) {
            const c = node.node.getChildren('CodeMark')
            for (const m of c) deco.push(hidden.range(m.from, m.to))
          }
          return false
        }
        if (name === 'Frontmatter') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            const cls = ['cm-frontmatter']
            if (n === first) cls.push('cm-frontmatter-first')
            if (n === last) cls.push('cm-frontmatter-last')
            deco.push(Decoration.line({ class: cls.join(' ') }).range(doc.line(n).from))
          }
          return false
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          let blockActive = false
          if (focused) for (const n of active) if (n >= first && n <= last) blockActive = true
          for (let n = first; n <= last; n++) {
            const cls = ['cm-codeblock']
            if (n === first) cls.push('cm-codeblock-first')
            if (n === last) cls.push('cm-codeblock-last')
            if (name === 'FencedCode' && (n === first || n === last)) cls.push('cm-codeblock-fence')
            deco.push(Decoration.line({ class: cls.join(' ') }).range(doc.line(n).from))
          }
          if (name === 'FencedCode') {
            const info = node.node.getChild('CodeInfo')
            if (info) deco.push(Decoration.mark({ class: 'cm-code-lang' }).range(info.from, info.to))
            if (!blockActive) {
              // 非编辑状态隐藏 ``` 围栏，只留语言名
              for (const m of node.node.getChildren('CodeMark')) deco.push(hidden.range(m.from, m.to))
            }
          }
          return false
        }
        if (name === 'HashTag') {
          const tag = doc.sliceString(node.from + 1, node.to).replace(/^\/+|\/+$/g, '').toLowerCase()
          deco.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': tag } }).range(node.from, node.to))
          return false
        }
        if (name === 'Blockquote') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) deco.push(Decoration.line({ class: 'cm-quote' }).range(doc.line(n).from))
          return
        }
        if (name === 'QuoteMark') {
          if (!isActive(node.from)) {
            let end = node.to
            if (doc.sliceString(end, end + 1) === ' ') end++
            deco.push(hidden.range(node.from, end))
          }
          return
        }
        if (name === 'HorizontalRule') {
          if (!isActive(node.from)) deco.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
          return
        }
        if (name === 'ListMark') {
          const text = doc.sliceString(node.from, node.to)
          const item = node.node.parent
          const task = item?.getChild('Task')
          if (task) {
            // 任务列表：隐藏列表符号，复选框始终渲染
            if (!isActive(node.from)) deco.push(hidden.range(node.from, Math.min(node.to + 1, task.from)))
            return
          }
          if (/^[-*+]$/.test(text) && !isActive(node.from)) {
            deco.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
          }
          return
        }
        if (name === 'TaskMarker') {
          const mark = doc.sliceString(node.from, node.to)
          const checked = /\[[xX]\]/.test(mark)
          if (!isActive(node.from) || !focused) {
            deco.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
          }
          if (checked) {
            const line = doc.lineAt(node.from)
            if (node.to + 1 < line.to) deco.push(Decoration.mark({ class: 'cm-task-done' }).range(node.to + 1, line.to))
          }
          return
        }
        if (name === 'WikiLink' || name === 'WikiEmbed') {
          const embed = name === 'WikiEmbed'
          const openLen = embed ? 3 : 2
          const innerFrom = node.from + openLen
          const innerTo = node.to - 2
          const inner = doc.sliceString(innerFrom, innerTo)
          const link = parseLinkInner(inner)
          if (embed && IMAGE_RE.test(link.target)) {
            if (!isActive(node.from)) {
              deco.push(
                Decoration.replace({ widget: new ImageWidget(embedSources(link.target, notePath), link.alias || link.target) }).range(
                  node.from,
                  node.to,
                ),
              )
            }
            return false
          }
          const exists = ctx.linkExists(link.target, notePath)
          deco.push(
            Decoration.mark({
              class: exists ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-missing',
              attributes: { 'data-target': link.target, 'data-heading': link.heading },
            }).range(innerFrom, innerTo),
          )
          if (!isActive(node.from)) {
            deco.push(hidden.range(node.from, innerFrom))
            deco.push(hidden.range(innerTo, node.to))
            const bar = inner.search(/(?<!\\)\|/)
            if (bar >= 0 && link.alias) deco.push(hidden.range(innerFrom, innerFrom + bar + 1))
          }
          return false
        }
        if (name === 'Image') {
          const urlNode = node.node.getChild('URL')
          if (!urlNode || isActive(node.from)) return false
          const raw = doc.sliceString(urlNode.from, urlNode.to).replace(/^<|>$/g, '')
          const text = doc.sliceString(node.from, node.to)
          const alt = /^!\[([^\]]*)\]/.exec(text)?.[1] ?? ''
          deco.push(Decoration.replace({ widget: new ImageWidget(imageSources(raw, notePath), alt) }).range(node.from, node.to))
          return false
        }
        if (name === 'Link') {
          const marks = node.node.getChildren('LinkMark')
          const urlNode = node.node.getChild('URL')
          // 只有 [文字] 没有地址时按普通文本显示
          if (marks.length < 2 || (!urlNode && !node.node.getChild('LinkLabel'))) return false
          const textFrom = marks[0].to
          const textTo = marks[1].from
          if (textTo > textFrom) {
            const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : ''
            deco.push(Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': url } }).range(textFrom, textTo))
          }
          if (!isActive(node.from)) {
            deco.push(hidden.range(node.from, textFrom))
            deco.push(hidden.range(textTo, node.to))
          }
          return false
        }
        if (name === 'URL' && node.node.parent?.name !== 'Link' && node.node.parent?.name !== 'Image') {
          deco.push(
            Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': doc.sliceString(node.from, node.to) } }).range(
              node.from,
              node.to,
            ),
          )
          return
        }
      },
    })
  }
  return RangeSet.of(deco, true)
}

/** 实时预览：光标不在的行隐藏 Markdown 标记，渲染复选框、图片、分隔线和链接。 */
export function livePreview(ctx: PreviewContext) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, ctx)
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPreview)))
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || refresh || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, ctx)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  const toggleTask = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target as HTMLElement
      if (el instanceof HTMLInputElement && el.classList.contains('cm-task-checkbox')) {
        e.preventDefault()
        const pos = Number(el.dataset.pos)
        const mark = view.state.doc.sliceString(pos, pos + 3)
        const next = /\[[xX]\]/.test(mark) ? '[ ]' : '[x]'
        view.dispatch({ changes: { from: pos, to: pos + 3, insert: next }, userEvent: 'input.toggle' })
        return true
      }
      return false
    },
  })

  return [plugin, toggleTask]
}

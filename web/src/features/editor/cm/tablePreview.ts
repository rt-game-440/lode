// 表格实时预览：光标不在表格里时把 GFM 表格渲染成真正的 <table>，进入表格后切回源码编辑。
// 块级装饰必须由 StateField 提供（CodeMirror 不允许 ViewPlugin 提供 block 装饰），所以与 livePreview 分开。
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view'
import { type PreviewContext, ImageWidget, embedSources, imageSources, refreshPreview } from './livePreview'
import { type Inline, type SyntaxNode, type TableModel, modelKey, parseTable } from './tableModel'

const setFocus = StateEffect.define<boolean>()

interface Interaction {
  /** 编辑器是否有焦点；没有焦点时所有表格都渲染 */
  focused: boolean
  /** 用户是否已经在这份文档上操作过（点击、移动光标、输入）。刚打开笔记时光标默认在正文开头，不应让开头的表格变成源码 */
  engaged: boolean
}

const interaction = StateField.define<Interaction>({
  create: () => ({ focused: false, engaged: false }),
  update(v, tr) {
    let { focused, engaged } = v
    for (const e of tr.effects) if (e.is(setFocus)) focused = e.value
    if (tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move') || tr.isUserEvent('undo') || tr.isUserEvent('redo')) engaged = true
    return focused === v.focused && engaged === v.engaged ? v : { focused, engaged }
  },
})

function appendInline(parent: Node, items: Inline[], ctx: PreviewContext, notePath: string) {
  for (const it of items) {
    switch (it.t) {
      case 'text':
        parent.appendChild(document.createTextNode(it.s))
        break
      case 'strong':
      case 'em':
      case 'del': {
        const el = document.createElement(it.t === 'strong' ? 'strong' : it.t === 'em' ? 'em' : 'del')
        appendInline(el, it.c, ctx, notePath)
        parent.appendChild(el)
        break
      }
      case 'code': {
        const el = document.createElement('code')
        el.className = 'cm-inline-code'
        el.textContent = it.s
        parent.appendChild(el)
        break
      }
      case 'link': {
        const el = document.createElement('span')
        el.className = 'cm-md-link'
        el.dataset.href = it.href
        appendInline(el, it.c, ctx, notePath)
        parent.appendChild(el)
        break
      }
      case 'wikilink': {
        const el = document.createElement('span')
        el.className = ctx.linkExists(it.target, notePath) ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-missing'
        el.dataset.target = it.target
        el.dataset.heading = it.heading
        el.textContent = it.label
        parent.appendChild(el)
        break
      }
      case 'embed': {
        if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(it.target)) {
          parent.appendChild(new ImageWidget(embedSources(it.target, notePath), it.alias || it.target).toDOM())
        } else {
          parent.appendChild(document.createTextNode(it.alias || it.target))
        }
        break
      }
      case 'image':
        parent.appendChild(new ImageWidget(imageSources(it.src, notePath), it.alt).toDOM())
        break
      case 'tag': {
        const el = document.createElement('span')
        el.className = 'cm-tag'
        el.dataset.tag = it.tag
        el.textContent = it.s
        parent.appendChild(el)
        break
      }
      case 'br':
        parent.appendChild(document.createElement('br'))
        break
    }
  }
}

/** 模型里所有 wikilink 当前是否存在，拼成串参与 eq：新建或删除目标笔记后表格里的链接样式要跟着变。 */
function linkStatus(items: Inline[], ctx: PreviewContext, notePath: string): string {
  let s = ''
  for (const it of items) {
    if (it.t === 'wikilink') s += ctx.linkExists(it.target, notePath) ? '1' : '0'
    else if (it.t === 'strong' || it.t === 'em' || it.t === 'del' || it.t === 'link') s += linkStatus(it.c, ctx, notePath)
  }
  return s
}

class TableWidget extends WidgetType {
  private readonly key: string
  private readonly status: string

  constructor(
    readonly model: TableModel,
    readonly ctx: PreviewContext,
    readonly notePath: string,
  ) {
    super()
    this.key = modelKey(model)
    let st = ''
    for (const row of [model.head, ...model.rows]) for (const c of row) st += linkStatus(c.content, ctx, notePath)
    this.status = st
  }

  eq(o: TableWidget) {
    return o.key === this.key && o.status === this.status && o.notePath === this.notePath
  }

  toDOM() {
    const { model, ctx, notePath } = this
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-widget'
    const scroll = document.createElement('div')
    scroll.className = 'cm-table-scroll'
    const table = document.createElement('table')
    const row = (cells: TableModel['head'], tag: 'th' | 'td') => {
      const tr = document.createElement('tr')
      cells.forEach((c, i) => {
        const cell = document.createElement(tag)
        // 相对表格起点的偏移：表格上方内容变化时 widget 不重建，所以不存绝对位置
        cell.dataset.off = String(c.from - model.from)
        const align = model.aligns[i]
        if (align) cell.style.textAlign = align
        appendInline(cell, c.content, ctx, notePath)
        tr.appendChild(cell)
      })
      return tr
    }
    const thead = document.createElement('thead')
    thead.appendChild(row(model.head, 'th'))
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const r of model.rows) tbody.appendChild(row(r, 'td'))
    table.appendChild(tbody)
    scroll.appendChild(table)
    wrap.appendChild(scroll)
    return wrap
  }

  // 返回 false：让点击事件进入编辑器的处理链（单元格定位、链接打开）
  ignoreEvent() {
    return false
  }

  get estimatedHeight() {
    return (this.model.rows.length + 1) * 34 + 16
  }
}

/** 选区是否让这个表格进入源码状态：有焦点且用户操作过，且某个选区与表格相交（整表被选中时仍保持渲染）。 */
function isEditing(state: EditorState, from: number, to: number, focused: boolean): boolean {
  if (!focused) return false
  return state.selection.ranges.some((r) => {
    if (r.to < from || r.from > to) return false
    return r.empty || r.from > from || r.to < to
  })
}

function build(state: EditorState, ctx: PreviewContext): DecorationSet {
  const it = state.field(interaction, false)
  const focused = !!it && it.focused && it.engaged
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  const src = state.doc.toString()
  const notePath = ctx.notePath()
  const deco: Range<Decoration>[] = []
  const top = tree.topNode
  for (let n: SyntaxNode | null = top.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'Table') continue
    if (isEditing(state, n.from, n.to, focused)) {
      const first = state.doc.lineAt(n.from).number
      const last = state.doc.lineAt(n.to).number
      for (let i = first; i <= last; i++) deco.push(Decoration.line({ class: 'cm-table-raw' }).range(state.doc.line(i).from))
      continue
    }
    const model = parseTable(src, n)
    if (!model) continue
    deco.push(Decoration.replace({ widget: new TableWidget(model, ctx, notePath), block: true }).range(n.from, n.to))
  }
  return Decoration.set(deco, true)
}

/** 点击渲染后的单元格：光标落到该单元格的源码位置，表格随之切到源码。链接交给 linkClicks。 */
const cellClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false
    const el = e.target as HTMLElement
    if (el.closest('.cm-wikilink, .cm-md-link, .cm-tag')) return false
    const cell = el.closest<HTMLElement>('.cm-table-widget td, .cm-table-widget th')
    const widget = el.closest<HTMLElement>('.cm-table-widget')
    if (!cell || !widget) return false
    const pos = view.posAtDOM(widget) + Number(cell.dataset.off ?? 0)
    e.preventDefault()
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select.pointer' })
    view.focus()
    return true
  },
})

export function tablePreview(ctx: PreviewContext) {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, ctx),
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(refreshPreview) || e.is(setFocus))
      if (tr.docChanged || tr.selection || refresh || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state, ctx)
      return value
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  // 渲染态的表格是一整块 widget，默认按上下键会直接越过它。紧挨着表格的那一行按方向键时，把光标放进表格（切到源码）
  const enter = (dir: 1 | -1) => (view: EditorView) => {
    const { state } = view
    const sel = state.selection.main
    if (!sel.empty) return false
    const line = state.doc.lineAt(sel.head)
    const edge = dir === 1 ? line.to + 1 : line.from - 1
    let target = -1
    state.field(field).between(edge, edge, (from, to, v) => {
      if (v.spec.widget instanceof TableWidget && (dir === 1 ? from === edge : to === edge)) target = dir === 1 ? from : to
    })
    if (target < 0) return false
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: 'select' })
    return true
  }
  const keys = Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: enter(1) },
      { key: 'ArrowUp', run: enter(-1) },
    ]),
  )
  return [interaction, EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing)), field, cellClick, keys]
}

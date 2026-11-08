import {
  Annotation,
  EditorSelection,
  EditorState,
  type Extension,
  StateField,
  type Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view'
import { type NoteAppearance, hiddenAppearanceRange, readAppearance, writeAppearance } from '../../../lib/noteAppearance'
import { diffChangeSet } from '../../../sync/textdiff'

/**
 * 笔记外观（页宽、字体）写在 front matter 的 `lode` 键里（lib/noteAppearance）。编辑器里：
 * - 从文档读出外观，交给界面（onAppearance）；
 * - 把 `lode` 这几行藏起来（front matter 只有它时整块藏起），光标进不去，普通编辑也改不到它，
 *   只能通过“外观和布局”菜单修改（带 appearanceWrite 标记），或来自服务器、撤销重做。
 */

/** 标记“外观和布局”菜单写入 front matter 的事务 */
export const appearanceWrite = Annotation.define<boolean>()

/** front matter 只在文档开头；只看前几百行，避免每次按键都把整篇转成字符串 */
const HEAD_LINES = 300

interface Hidden {
  from: number
  to: number
  whole: boolean
}

interface AppearanceInfo {
  appearance: NoteAppearance
  hidden: Hidden | null
}

function head(doc: Text): string {
  return doc.sliceString(0, doc.line(Math.min(doc.lines, HEAD_LINES)).to)
}

function compute(doc: Text): AppearanceInfo {
  const text = head(doc)
  // 截断的开头没有下一行时不藏（hiddenAppearanceRange 要求区间后面还有一行）
  const hidden = hiddenAppearanceRange(doc.lines > HEAD_LINES ? text + '\n' : text)
  return { appearance: readAppearance(text), hidden: hidden && hidden.to < doc.length ? hidden : null }
}

const appearanceField = StateField.define<AppearanceInfo>({
  create: (state) => compute(state.doc),
  update: (value, tr) => (tr.docChanged ? compute(tr.newDoc) : value),
})

const hiddenDecorations = StateField.define<DecorationSet>({
  create: (state) => decorate(state.field(appearanceField).hidden),
  update: (deco, tr) => {
    if (!tr.docChanged) return deco
    const prev = tr.startState.field(appearanceField).hidden
    const next = tr.state.field(appearanceField).hidden
    return prev?.from === next?.from && prev?.to === next?.to ? deco.map(tr.changes) : decorate(next)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function decorate(h: Hidden | null): DecorationSet {
  return h ? Decoration.set([Decoration.replace({ block: true }).range(h.from, h.to)]) : Decoration.none
}

/** 光标不能停的区间：整块藏起时从文档开头到藏起部分的末尾；只藏几行时是这几行本身 */
function blocked(h: Hidden): [number, number] {
  return h.whole ? [0, h.to] : [h.from, h.to]
}

/** 被藏起的这一段后面第一行的行首：整块藏起时就是正文的开头 */
export function bodyStart(text: string): number {
  const h = hiddenAppearanceRange(text)
  return h?.whole ? h.to + 1 : 0
}

function clampSelection(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!tr.docChanged && !tr.selection) return tr
  const h = compute(tr.newDoc).hidden
  if (!h) return tr
  const [lo, hi] = blocked(h)
  const prevHead = tr.startState.selection.main.head
  const sel = tr.newSelection
  let moved = false
  const fix = (pos: number, up: boolean) => {
    if (pos < lo || pos > hi) return pos
    moved = true
    // 只藏几行时，往上移的光标停在它上一行的行尾；其余情况停在它下一行的行首
    return !h.whole && up ? lo - 1 : hi + 1
  }
  const ranges = sel.ranges.map((r) => {
    const up = r.head < prevHead
    return EditorSelection.range(fix(r.anchor, up), fix(r.head, up))
  })
  if (!moved) return tr
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }]
}

/**
 * @param trusted 可以改动藏起部分的事务（例如来自服务器的内容替换）
 * @param onAppearance 外观变化时调用；animate 为 false 表示是载入新文档，不做过渡
 */
export function noteAppearance(trusted: (tr: Transaction) => boolean, onAppearance: (a: NoteAppearance, animate: boolean) => void): Extension {
  return [
    appearanceField,
    hiddenDecorations,
    EditorState.transactionFilter.of(clampSelection),
    EditorState.changeFilter.of((tr) => {
      if (tr.annotation(appearanceWrite) || tr.isUserEvent('undo') || tr.isUserEvent('redo') || trusted(tr)) return true
      const h = tr.startState.field(appearanceField).hidden
      if (!h) return true
      // 区间两端各多算一个换行：删掉相邻的换行同样会破坏 front matter；在两端插入不受影响
      const [lo, hi] = blocked(h)
      return [Math.max(0, lo - 1), Math.min(tr.startState.doc.length, hi + 1)]
    }),
    ViewPlugin.define((view) => {
      let last = view.state.field(appearanceField).appearance
      onAppearance(last, false)
      return {
        update(u) {
          const a = u.state.field(appearanceField).appearance
          if (a.width === last.width && a.font === last.font) return
          last = a
          onAppearance(a, true)
        },
      }
    }),
  ]
}

/**
 * 把外观写进当前笔记的 front matter：作为普通编辑交给编辑器，随后由自动保存走正常的保存和同步
 * （版本号、三方合并、冲突处理），也能撤销。返回是否有改动。
 */
export function applyNoteAppearance(view: EditorView, patch: Partial<NoteAppearance>): boolean {
  const cur = view.state.doc.toString()
  const next = writeAppearance(cur, patch)
  if (next === cur) return false
  view.dispatch({ changes: diffChangeSet(cur, next), annotations: appearanceWrite.of(true), userEvent: 'input.appearance' })
  return true
}

/** 当前文档的外观 */
export function appearanceOf(state: EditorState): NoteAppearance {
  return state.field(appearanceField).appearance
}

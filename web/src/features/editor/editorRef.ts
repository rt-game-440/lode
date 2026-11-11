import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** 当前编辑器实例，供大纲跳转等界面使用。 */
export const editorRef: { view: EditorView | null; extensions: Extension[] } = { view: null, extensions: [] }

let titleFocusFor: string | null = null

/** 新建笔记后，打开时先聚焦标题输入框。 */
export function requestTitleFocus(id: string) {
  titleFocusFor = id
}

export function takeTitleFocus(id: string): boolean {
  if (titleFocusFor !== id) return false
  titleFocusFor = null
  return true
}

/** 滚动到指定行（从 1 开始）并把光标放在行首。 */
export function revealLine(line: number) {
  const view = editorRef.view
  if (!view) return
  const n = Math.min(Math.max(1, line), view.state.doc.lines)
  const pos = view.state.doc.line(n).from
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  // 浏览模式下只滚动到位置，不抢焦点（否则会弹出键盘）
  if (!view.state.readOnly) view.focus()
}

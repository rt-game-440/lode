import { EditorView, type ViewUpdate } from '@codemirror/view'

type Listener = (u: ViewUpdate) => void

const listeners = new WeakMap<EditorView, Set<Listener>>()

/**
 * 把编辑器的每次更新转给外部订阅者（选区悬浮工具框用它跟踪选区、改动和几何变化）。
 * 放在 editorExtensions 里：切换笔记时 setState 重建状态也会保留，订阅者不用重新挂载。
 */
export const editorUpdateEvents = EditorView.updateListener.of((u) => {
  const set = listeners.get(u.view)
  if (set) for (const fn of set) fn(u)
})

/** 订阅某个编辑器的更新，返回取消订阅函数。 */
export function onEditorUpdate(view: EditorView, fn: Listener): () => void {
  let set = listeners.get(view)
  if (!set) listeners.set(view, (set = new Set()))
  set.add(fn)
  return () => set.delete(fn)
}

/**
 * 进入助手页前记下笔记的滚动位置，从助手页返回同一篇笔记时恢复（只用一次）。
 */
let pending: { id: string; top: number } | null = null

export function rememberNoteScroll(id: string) {
  const el = document.querySelector<HTMLElement>('.editor-scroll')
  pending = el ? { id, top: el.scrollTop } : null
}

/** 取出并清除：只在 id 对得上时返回。 */
export function takeNoteScroll(id: string): number | null {
  const p = pending
  if (!p || p.id !== id) return null
  pending = null
  return p.top
}

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { dirname } from '../../../lib/paths'
import { fuzzyScore } from '../../../lib/snippet'

export interface LinkCandidate {
  path: string
  title: string
  /** 插入到 [[ ]] 里的文本 */
  linkText: string
}

/** [[ 之后的补全：按标题和路径模糊匹配笔记。 */
export function wikiLinkCompletion(candidates: () => LinkCandidate[]) {
  return (cx: CompletionContext): CompletionResult | null => {
    const line = cx.state.doc.lineAt(cx.pos)
    const before = line.text.slice(0, cx.pos - line.from)
    const open = before.lastIndexOf('[[')
    if (open < 0) return null
    const query = before.slice(open + 2)
    if (query.includes(']]') || query.includes('|') || query.includes('#')) return null
    const from = line.from + open + 2
    // 光标后已有 ]] 时只替换目标文本
    const after = line.text.slice(cx.pos - line.from)
    const closeAfter = after.startsWith(']]')
    const scored: { c: LinkCandidate; s: number }[] = []
    for (const c of candidates()) {
      const s = query ? Math.max(fuzzyScore(query, c.title) + 50, fuzzyScore(query, c.path)) : 0
      if (s >= 0) scored.push({ c, s })
    }
    scored.sort((a, b) => b.s - a.s || a.c.path.length - b.c.path.length)
    const options: Completion[] = scored.slice(0, 50).map(({ c }) => ({
      label: c.title,
      detail: dirname(c.path),
      type: 'text',
      apply: (view, _completion, f, t) => {
        // 光标移到 ]] 之后
        const insert = closeAfter ? c.linkText : `${c.linkText}]]`
        view.dispatch({
          changes: { from: f, to: t, insert },
          selection: { anchor: f + insert.length + (closeAfter ? 2 : 0) },
          userEvent: 'input.complete',
        })
      },
    }))
    return { from, options, filter: false }
  }
}

/** 输入 [[ 时自动补上 ]]。 */
export const autoCloseWikiLink = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '[') return false
  const prev = view.state.doc.sliceString(from - 1, from)
  const next = view.state.doc.sliceString(to, to + 2)
  if (prev !== '[' || next.startsWith(']')) return false
  view.dispatch({
    changes: { from, to, insert: '[]]' },
    selection: { anchor: from + 1 },
    userEvent: 'input.type',
  })
  return true
})

export interface LinkHandlers {
  openWikiLink: (target: string, heading: string, newTab: boolean) => void
  openTag: (tag: string) => void
}

/** 点击链接：预览状态（非活动行）直接点击打开，编辑状态需按住 Ctrl/Cmd。 */
export function linkClicks(h: LinkHandlers) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-wikilink, .cm-md-link, .cm-tag')
      if (!el) return false
      const pos = view.posAtDOM(el)
      const line = view.state.doc.lineAt(pos).number
      // 渲染态表格里的链接没有“正在编辑的行”，点击总是直接打开
      const onActiveLine =
        !el.closest('.cm-table-widget') &&
        view.hasFocus && view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.head).number === line)
      const mod = e.ctrlKey || e.metaKey
      if (onActiveLine && !mod) return false
      e.preventDefault()
      if (el.classList.contains('cm-tag')) {
        h.openTag(el.dataset.tag ?? '')
      } else if (el.classList.contains('cm-wikilink')) {
        h.openWikiLink(el.dataset.target ?? '', el.dataset.heading ?? '', mod)
      } else {
        const href = el.dataset.href ?? ''
        if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
        else if (href) h.openWikiLink(decodeURIComponentSafe(href), '', mod)
      }
      return true
    },
  })
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 上传图片并依次插入 ![[路径]]：pos 为 null 时替换当前选区，否则插在 pos 处（拖入）。
 * 粘贴、拖入和手机工具栏的“图片”按钮共用。
 */
export async function insertImages(
  view: EditorView,
  files: File[],
  upload: (file: File) => Promise<string>,
  onError: (err: unknown) => void,
  pos: number | null = null,
) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try {
      const path = await upload(f)
      const sel = view.state.selection.main
      const at = pos ?? sel.from
      const text = `![[${path}]]`
      view.dispatch({
        changes: { from: at, to: pos === null ? sel.to : at, insert: text },
        selection: { anchor: at + text.length },
        scrollIntoView: true,
        userEvent: 'input.paste',
      })
      pos = null
    } catch (err) {
      onError(err)
    }
  }
}

/** 粘贴或拖入图片：上传到 attachments/ 并插入 ![[路径]]。 */
export function imagePaste(upload: (file: File) => Promise<string>, onError: (err: unknown) => void) {
  const handle = (view: EditorView, files: File[], pos: number | null) => {
    if (!files.some((f) => f.type.startsWith('image/'))) return false
    // 浏览模式：拖入的图片不插入（调用方已 preventDefault，不会让浏览器打开图片）
    if (view.state.readOnly) return true
    void insertImages(view, files, upload, onError, pos)
    return true
  }
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.some((f) => f.type.startsWith('image/'))) return false
      e.preventDefault()
      return handle(view, files, null)
    },
    drop(e, view) {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.some((f) => f.type.startsWith('image/'))) return false
      e.preventDefault()
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      return handle(view, files, pos)
    },
  })
}

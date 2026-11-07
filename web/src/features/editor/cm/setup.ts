import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, keymap, placeholder } from '@codemirror/view'
import { type LinkCandidate, type LinkHandlers, autoCloseWikiLink, imagePaste, linkClicks, wikiLinkCompletion } from './extras'
import { type PreviewContext, livePreview } from './livePreview'
import { editorHighlight, editorTheme } from './theme'
import { wikiLinkSyntax } from './wikilinkSyntax'

export interface EditorEnv extends PreviewContext, LinkHandlers {
  candidates: () => LinkCandidate[]
  upload: (file: File) => Promise<string>
  onUploadError: (err: unknown) => void
  onDocChange: (content: string) => void
  onSave: () => void
}

/** 编辑器的全部扩展。env 里的函数在每次调用时读取最新状态，因此只需创建一次。 */
export function editorExtensions(env: EditorEnv): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'sentences', 'aria-label': '笔记正文' }),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [wikiLinkSyntax] }),
    editorHighlight,
    editorTheme,
    placeholder('开始书写…'),
    search({ top: true }),
    highlightSelectionMatches(),
    closeBrackets(),
    autoCloseWikiLink,
    autocompletion({ override: [wikiLinkCompletion(env.candidates)], icons: false, activateOnTyping: true }),
    livePreview(env),
    linkClicks(env),
    imagePaste(env.upload, env.onUploadError),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          env.onSave()
          return true
        },
      },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && u.transactions.some((tr) => !tr.annotation(remoteSync))) env.onDocChange(u.state.doc.toString())
    }),
  ]
}


/** 标记来自服务器的内容替换，不触发自动保存。 */
export const remoteSync = Annotation.define<boolean>()

/**
 * 把编辑器内容替换为 next，只改动首尾相同部分之间的区域，
 * 让光标和滚动位置尽量保持不动。
 */
export function replaceDoc(view: EditorView, next: string) {
  const cur = view.state.doc.toString()
  if (cur === next) return
  let start = 0
  const min = Math.min(cur.length, next.length)
  while (start < min && cur.charCodeAt(start) === next.charCodeAt(start)) start++
  let endCur = cur.length
  let endNext = next.length
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--
    endNext--
  }
  view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
    annotations: [remoteSync.of(true)],
  })
}

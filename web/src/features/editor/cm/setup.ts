import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, keymap, placeholder } from '@codemirror/view'
import type { NoteAppearance } from '../../../lib/noteAppearance'
import { noteAppearance } from './appearance'
import { type LinkCandidate, type LinkHandlers, autoCloseWikiLink, imagePaste, linkClicks, wikiLinkCompletion } from './extras'
import { FORMAT_ACTIONS } from './formatActions'
import { type PreviewContext, livePreview } from './livePreview'
import { tablePreview } from './tablePreview'
import { editorHighlight, editorTheme } from './theme'
import { wikiLinkSyntax } from './wikilinkSyntax'

export interface EditorEnv extends PreviewContext, LinkHandlers {
  candidates: () => LinkCandidate[]
  upload: (file: File) => Promise<string>
  onUploadError: (err: unknown) => void
  onDocChange: (content: string) => void
  onSave: () => void
  /** 笔记外观（front matter 的 lode 键）变化；animate 为 false 表示载入了新文档 */
  onAppearance: (a: NoteAppearance, animate: boolean) => void
}

/**
 * 浏览模式开关。放在单独的 Compartment 里：状态重建（切换笔记）时由 EditorPane 带上当前值，
 * 切换模式时用 reconfigure 原地修改，不重建文档。
 */
export const browseCompartment = new Compartment()

/** 浏览模式：不可编辑、不聚焦（不弹键盘）。链接点击、表格渲染、任务勾选不受影响。 */
export function browseExtension(browse: boolean): Extension {
  return browse ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
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
    tablePreview(env),
    noteAppearance((tr) => !!tr.annotation(remoteSync), env.onAppearance),
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
      ...FORMAT_ACTIONS.map((a) => ({
        key: a.key,
        preventDefault: true,
        run: (v: EditorView) => {
          // 浏览模式下格式快捷键不改内容，但仍吞掉按键，避免浏览器自己的快捷键生效
          if (v.state.readOnly) return true
          v.dispatch(a.run(v.state))
          if (a.id === 'wikilink') startCompletion(v)
          return true
        },
      })),
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

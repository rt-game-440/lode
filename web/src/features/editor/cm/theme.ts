import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/** 编辑器外观，颜色全部取自设计 tokens，亮暗主题自动跟随。 */
export const editorTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--text-editor)',
    color: 'var(--color-label)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-sans)',
    lineHeight: 'var(--leading-body)',
    // 外层 .editor-scroll 负责滚动，标题和正文一起滚动
    overflow: 'visible',
  },
  '.cm-content': {
    maxWidth: 'var(--editor-max-width)',
    margin: '0 auto',
    padding: 'var(--space-3) var(--space-6) 40vh',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-text-selection) !important',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },

  // 标题
  '.cm-h': { fontWeight: 'var(--weight-bold)', letterSpacing: 'var(--tracking-title)', lineHeight: 'var(--leading-tight)' },
  '.cm-h1': { fontSize: '1.75em', paddingTop: '0.6em !important', paddingBottom: '0.15em !important' },
  '.cm-h2': { fontSize: '1.45em', paddingTop: '0.5em !important', paddingBottom: '0.1em !important' },
  '.cm-h3': { fontSize: '1.22em', paddingTop: '0.4em !important' },
  '.cm-h4': { fontSize: '1.08em', paddingTop: '0.3em !important' },
  '.cm-h5, .cm-h6': { fontSize: '1em', paddingTop: '0.2em !important', color: 'var(--color-label-secondary)' },

  // 链接
  '.cm-wikilink, .cm-md-link': {
    color: 'var(--color-accent)',
    textDecoration: 'none',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  '.cm-wikilink:hover, .cm-md-link:hover': { textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.cm-wikilink-missing': { opacity: '0.62', textDecoration: 'underline dashed', textUnderlineOffset: '3px' },

  // 代码
  '.cm-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    backgroundColor: 'var(--color-code-bg)',
    borderRadius: '4px',
    padding: '0.1em 0.3em',
  },
  '.cm-codeblock': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.86em',
    backgroundColor: 'var(--color-code-bg)',
    padding: '0 0.9em !important',
    lineHeight: '1.55',
  },
  '.cm-codeblock-first': { borderTopLeftRadius: 'var(--radius-md)', borderTopRightRadius: 'var(--radius-md)', paddingTop: '0.35em !important' },
  '.cm-codeblock-last': { borderBottomLeftRadius: 'var(--radius-md)', borderBottomRightRadius: 'var(--radius-md)', paddingBottom: '0.35em !important' },
  '.cm-codeblock-fence': { color: 'var(--color-label-tertiary)' },

  // frontmatter
  '.cm-frontmatter': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8em',
    lineHeight: '1.6',
    color: 'var(--color-label-secondary)',
    backgroundColor: 'var(--color-fill)',
    padding: '0 0.9em !important',
  },
  '.cm-frontmatter *': { color: 'inherit !important', fontWeight: 'normal !important', fontStyle: 'normal !important' },
  '.cm-frontmatter-first': { borderTopLeftRadius: 'var(--radius-md)', borderTopRightRadius: 'var(--radius-md)', paddingTop: '0.3em !important' },
  '.cm-frontmatter-last': {
    borderBottomLeftRadius: 'var(--radius-md)',
    borderBottomRightRadius: 'var(--radius-md)',
    paddingBottom: '0.3em !important',
  },

  // 标签
  '.cm-tag': {
    color: 'var(--color-accent)',
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
    borderRadius: 'var(--radius-full)',
    padding: '0.05em 0.45em',
    fontSize: '0.92em',
    cursor: 'pointer',
  },
  '.cm-code-lang': { color: 'var(--color-label-tertiary)', fontSize: '0.85em', fontFamily: 'var(--font-sans)' },

  // 引用
  '.cm-quote': {
    borderLeft: '3px solid var(--color-md-quote-bar)',
    paddingLeft: '0.9em !important',
    color: 'var(--color-label-secondary)',
  },

  // 列表与任务
  '.cm-bullet': { color: 'var(--color-label-tertiary)', display: 'inline-block', width: '0.6em', fontWeight: 'bold' },
  '.cm-task-checkbox': {
    width: '1.05em',
    height: '1.05em',
    margin: '0 0.4em 0 0',
    verticalAlign: '-0.15em',
    accentColor: 'var(--color-accent-fill)',
    cursor: 'pointer',
  },
  '.cm-task-done': { color: 'var(--color-label-tertiary)', textDecoration: 'line-through' },
  '.cm-hr': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    verticalAlign: 'middle',
    backgroundColor: 'var(--color-separator-strong)',
  },

  // 图片
  '.cm-image': { display: 'inline-block', maxWidth: '100%', margin: '0.3em 0' },
  '.cm-image img': {
    maxWidth: '100%',
    maxHeight: '70vh',
    borderRadius: 'var(--radius-md)',
    display: 'block',
  },
  '.cm-image-broken': {
    minWidth: '8em',
    minHeight: '3em',
    border: '1px dashed var(--color-separator-strong)',
    borderRadius: 'var(--radius-md)',
  },
  '.cm-image-broken img': { display: 'none' },

  // 补全弹层
  '.cm-tooltip': {
    border: '1px solid var(--color-separator)',
    backgroundColor: 'var(--color-bg-elevated)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-md)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-subhead)',
    maxHeight: '16em',
    padding: '4px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '6px 10px',
    borderRadius: 'var(--radius-sm)',
    lineHeight: '1.3',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-accent-fill)',
    color: 'var(--color-on-accent)',
  },
  '.cm-completionDetail': { marginLeft: '0.75em', fontStyle: 'normal', opacity: '0.7', fontSize: '0.9em' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'var(--weight-semibold)' },

  // 搜索面板
  '.cm-panels': { backgroundColor: 'var(--color-bg-secondary)', color: 'var(--color-label)', borderColor: 'var(--color-separator)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-search-highlight)' },
})

/** Markdown 与代码块的语法高亮。 */
export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading, fontWeight: 'bold' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--color-md-mark)' },
    { tag: t.quote, color: 'var(--color-label-secondary)' },
    { tag: t.monospace, fontFamily: 'var(--font-mono)' },
    { tag: t.url, color: 'var(--color-label-tertiary)' },
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--color-code-keyword)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--color-code-string)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-code-number)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--color-code-comment)', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-code-function)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-code-type)' },
    { tag: [t.meta, t.annotation, t.tagName, t.attributeName], color: 'var(--color-code-meta)' },
  ]),
)

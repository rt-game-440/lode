import type { EditorState, TransactionSpec } from '@codemirror/state'
import { cycleHeading, insertLink, insertWikiLink, toggleList, toggleQuote, toggleWrap } from './format'

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export type FormatId = 'heading' | 'bold' | 'italic' | 'code' | 'list' | 'task' | 'quote' | 'link' | 'wikilink'

export interface FormatAction {
  id: FormatId
  label: string
  /** CodeMirror 键位写法 */
  key: string
  /** 提示文字里显示的快捷键 */
  shortcut: string
  run: (s: EditorState) => TransactionSpec
}

const MOD = isMac ? '⌘' : 'Ctrl+'
const SHIFT = isMac ? '⇧' : 'Shift+'
const sc = (shift: boolean, k: string) => `${MOD}${shift ? SHIFT : ''}${k}`

/** 格式命令及其键位：桌面顶栏按钮和编辑器键位共用这一份。 */
export const FORMAT_ACTIONS: FormatAction[] = [
  { id: 'heading', label: '标题', key: 'Mod-Shift-h', shortcut: sc(true, 'H'), run: cycleHeading },
  { id: 'bold', label: '加粗', key: 'Mod-b', shortcut: sc(false, 'B'), run: (s) => toggleWrap(s, '**') },
  { id: 'italic', label: '斜体', key: 'Mod-i', shortcut: sc(false, 'I'), run: (s) => toggleWrap(s, '*') },
  { id: 'code', label: '行内代码', key: 'Mod-e', shortcut: sc(false, 'E'), run: (s) => toggleWrap(s, '`') },
  { id: 'list', label: '列表', key: 'Mod-Shift-8', shortcut: sc(true, '8'), run: (s) => toggleList(s, 'bullet') },
  { id: 'task', label: '任务', key: 'Mod-Shift-9', shortcut: sc(true, '9'), run: (s) => toggleList(s, 'task') },
  { id: 'quote', label: '引用', key: 'Mod-Shift-u', shortcut: sc(true, 'U'), run: toggleQuote },
  { id: 'link', label: '链接', key: 'Mod-Shift-l', shortcut: sc(true, 'L'), run: insertLink },
  { id: 'wikilink', label: '笔记链接', key: 'Mod-Shift-y', shortcut: sc(true, 'Y'), run: insertWikiLink },
]

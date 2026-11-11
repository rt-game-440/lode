import { X } from 'lucide-react'
import { Modal } from '../../components/Modal'
import { IconButton } from '../../components/ui'
import { useUI } from '../../stores/ui'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'
const ALT = isMac ? '⌥' : 'Alt'

/** 快捷键一览：与 AppShell.useShortcuts、文件树和编辑器的键位保持一致。 */
export const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: '通用',
    items: [
      { keys: [MOD, 'K'], label: '快速切换笔记（也可用 Ctrl O）' },
      { keys: [MOD, ALT, 'N'], label: '新建笔记' },
      { keys: [MOD, '⇧', 'F'], label: '全文搜索' },
      { keys: [MOD, '\\'], label: '显示 / 隐藏侧栏' },
      { keys: ['?'], label: '显示本快捷键一览' },
      { keys: ['Esc'], label: '关闭弹出层' },
    ],
  },
  {
    title: '文件树',
    items: [
      { keys: ['↑', '↓'], label: '上下移动' },
      { keys: ['←', '→'], label: '收起 / 展开文件夹' },
      { keys: ['Enter'], label: '打开笔记或切换文件夹' },
      { keys: ['F2'], label: '重命名' },
      { keys: ['Delete'], label: '移到回收站' },
    ],
  },
  {
    title: '编辑器',
    items: [
      { keys: [MOD, 'Z'], label: '撤销' },
      { keys: [MOD, '⇧', 'Z'], label: '重做' },
      { keys: [MOD, '⇧', 'E'], label: '切换仅浏览 / 编辑（笔记页）' },
      { keys: ['[['], label: '插入笔记链接（带补全）' },
      { keys: [MOD, 'B'], label: '加粗（斜体 I，行内代码 E；其余见格式工具栏按钮提示）' },
      { keys: [MOD, '单击'], label: '打开正在编辑那一行里的链接（其他行直接单击）' },
    ],
  },
  {
    title: '侧栏宽度',
    items: [
      { keys: ['←', '→'], label: '聚焦调宽手柄后调整宽度（Shift 加大步长）' },
      { keys: ['双击手柄'], label: '恢复默认宽度' },
    ],
  },
]

/** 正在输入文字时不响应单键快捷键。 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export function ShortcutsDialog() {
  const open = useUI((s) => s.shortcutsOpen)
  const setOpen = useUI((s) => s.setShortcutsOpen)
  return (
    <Modal open={open} onClose={() => setOpen(false)} labelledBy="shortcuts-title" className="shortcuts">
      <header className="shortcuts-head">
        <h2 id="shortcuts-title" className="dialog-title">
          键盘快捷键
        </h2>
        <IconButton label="关闭" size="sm" onClick={() => setOpen(false)} data-autofocus>
          <X size={16} />
        </IconButton>
      </header>
      <div className="shortcuts-body">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="shortcuts-group" aria-labelledby={`sc-${g.title}`}>
            <h3 id={`sc-${g.title}`} className="shortcuts-group-title">
              {g.title}
            </h3>
            <dl className="shortcuts-list">
              {g.items.map((it) => (
                <div key={it.label} className="shortcuts-row">
                  <dt>{it.label}</dt>
                  <dd>
                    {it.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}

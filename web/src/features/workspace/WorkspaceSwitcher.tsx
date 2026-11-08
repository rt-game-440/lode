import { ChevronDown, Plus, Settings2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { type MenuEntry, openMenu, promptDialog } from '../../components/overlays'
import { useUI } from '../../stores/ui'
import { openSettings } from '../settings/nav'
import { useWorkspace, workspaceName } from '../../stores/workspace'
import './workspace.css'

/** 与服务端 workspace.cleanName 一致：去掉首尾空白后不能为空、不超过 64 个字符、不含控制字符。 */
export function invalidWorkspaceName(name: string): string | null {
  const v = name.trim()
  if (!v) return '请输入名称'
  const chars = [...v]
  if (chars.length > 64) return '名称不能超过 64 个字符'
  // Unicode 的 Cc 类：U+0000–001F、U+007F–009F（与 Go 的 unicode.IsControl 相同）
  const control = (ch: string) => {
    const c = ch.codePointAt(0) ?? 0
    return c < 0x20 || (c >= 0x7f && c <= 0x9f)
  }
  if (chars.some(control)) return '名称不能包含控制字符'
  return null
}

/** 新建工作空间并切换过去。 */
export async function promptCreateWorkspace() {
  const name = await promptDialog({
    title: '新建工作空间',
    label: '名称',
    placeholder: '例如：工作',
    confirmLabel: '创建',
    validate: invalidWorkspaceName,
  })
  if (name === null) return
  const ws = useWorkspace.getState()
  try {
    const info = await ws.create(name.trim())
    await ws.switchTo(info.id)
    useUI.getState().toast({ message: `已新建工作空间“${info.name}”`, tone: 'success' })
  } catch (err) {
    useUI.getState().toast({ message: `新建工作空间失败：${errorMessage(err)}`, tone: 'error' })
  }
}

/** 切换到另一个工作空间（侧栏列表和命令面板共用）。 */
export function switchWorkspace(id: string) {
  void useWorkspace.getState().switchTo(id)
}

/** 工作空间列表：当前项打勾，后面是“新建工作空间”。只有默认工作空间时列表里只有它自己。 */
function openWorkspaceMenu(anchor: HTMLElement) {
  const { list, current } = useWorkspace.getState()
  const items: MenuEntry[] = [{ heading: '工作空间' }]
  for (const w of list) {
    items.push({
      label: w.name,
      checked: w.id === current,
      hint: `${w.note_count} 篇`,
      run: () => {
        if (w.id !== current) switchWorkspace(w.id)
      },
    })
  }
  items.push(
    'separator',
    { label: '新建工作空间…', icon: <Plus size={16} />, run: () => void promptCreateWorkspace() },
    { label: '管理工作空间…', icon: <Settings2 size={16} />, run: () => openSettings(['workspaces']) },
  )
  // 打开时顺便刷新列表（笔记数等），已经显示的菜单不跟着变
  void useWorkspace.getState().load()
  openMenu(anchor, items)
}

/**
 * 侧栏顶部的工作空间名：点击弹出列表（切换、新建）。
 * 只有默认工作空间时看起来和原来的标题一样，只多一个不显眼的箭头。
 */
export function WorkspaceSwitcher() {
  const name = useWorkspace((s) => workspaceName(s.list, s.current))
  const many = useWorkspace((s) => s.list.length > 1)
  return (
    <button
      type="button"
      className={`ws-switcher hit-expand${many ? ' has-many' : ''}`}
      aria-haspopup="menu"
      aria-label={`工作空间：${name}`}
      title="切换或新建工作空间"
      data-testid="workspace-switcher"
      onClick={(e) => openWorkspaceMenu(e.currentTarget)}
    >
      <span className="ws-switcher-name">{name}</span>
      <ChevronDown size={14} strokeWidth={2.2} className="ws-switcher-chevron" aria-hidden="true" />
    </button>
  )
}

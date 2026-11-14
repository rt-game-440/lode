import { ChevronDown, Plus, Settings2 } from 'lucide-react'
import { useRef } from 'react'
import { errorMessage } from '../../api/client'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { useUI } from '../../stores/ui'
import { openSettings } from '../settings/nav'
import { useWorkspace, workspaceName } from '../../stores/workspace'
import { createWorkspaceDialog } from './CreateWorkspaceDialog'
import { useSwitcherDrop } from '../transfer/drop'
import './workspace.css'



/** 新建工作空间（可选接入已有文件夹）并切换过去。 */
export async function promptCreateWorkspace() {
  const info = await createWorkspaceDialog()
  if (!info) return
  try {
    await useWorkspace.getState().switchTo(info.id)
    useUI.getState().toast({ message: `已${info.external ? '接入' : '新建'}工作空间“${info.name}”`, tone: 'success' })
  } catch (err) {
    useUI.getState().toast({ message: `切换到新工作空间失败：${errorMessage(err)}`, tone: 'error' })
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
  const ref = useRef<HTMLButtonElement>(null)
  // 把文件树里的条目拖到这里：悬停片刻展开工作空间列表，放下即移动或复制（#72）
  const { switcherProps, highlight, dropList } = useSwitcherDrop(ref)
  return (
    <>
    <button
      ref={ref}
      type="button"
      className={`ws-switcher hit-expand${many ? ' has-many' : ''}${highlight ? ' is-drop-target' : ''}`}
      aria-haspopup="menu"
      aria-label={`工作空间：${name}`}
      title="切换或新建工作空间"
      data-testid="workspace-switcher"
      onClick={(e) => openWorkspaceMenu(e.currentTarget)}
      {...switcherProps}
    >
      <span className="ws-switcher-name">{name}</span>
      <ChevronDown size={14} strokeWidth={2.2} className="ws-switcher-chevron" aria-hidden="true" />
    </button>
    {dropList}
    </>
  )
}

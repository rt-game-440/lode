import { GripVertical, Layers, Pencil, Plus, Repeat, Trash2 } from 'lucide-react'
import { Reorder, useDragControls } from 'motion/react'
import { type KeyboardEvent, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import type { WorkspaceInfo } from '../../api/types'
import { confirmDialog, promptDialog } from '../../components/overlays'
import { EmptyState } from '../../components/ui'
import { DEFAULT_WORKSPACE, isDefaultWorkspace } from '../../lib/workspace'
import { useUI } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { errorMessage } from '../actions'
import { invalidWorkspaceName } from '../workspace/WorkspaceSwitcher'
import { useSettingsData } from './data'
import { settingsBack } from './nav'
import { ActionRow, CopyField, Group, InfoRow, NavRow, SettingsPage } from './parts'
import { SECTION_TITLE } from './stack'
import './workspace-settings.css'

// 设置里的“工作空间”：列表（拖动或键盘排序、新建）和单个工作空间（重命名、位置、删除）。

function toast(message: string, tone?: 'error' | 'success') {
  useUI.getState().toast({ message, tone })
}

/** 管理操作的错误提示：404 是工作空间已经不在了（比如在别的设备上删掉了）。 */
function workspaceError(err: unknown) {
  if (err instanceof ApiError && err.status === 404) return '工作空间不存在，可能已在别处被删除'
  return errorMessage(err)
}

async function createWorkspace() {
  const name = await promptDialog({
    title: '新建工作空间',
    label: '名称',
    placeholder: '例如：工作',
    confirmLabel: '创建',
    validate: invalidWorkspaceName,
  })
  if (name === null) return
  try {
    const info = await useWorkspace.getState().create(name.trim())
    toast(`已新建“${info.name}”`, 'success')
  } catch (err) {
    toast(`新建工作空间失败：${workspaceError(err)}`, 'error')
  }
}

/* ---------------- 列表 ---------------- */

export function WorkspacesPage({ sub }: { sub: string[] }) {
  const list = useWorkspace((s) => s.list)
  const current = useWorkspace((s) => s.current)
  const reorder = useWorkspace((s) => s.reorder)
  // 拖动过程中的顺序（id），松手后写回服务器；没有拖动时直接用 store 的顺序（键盘连按时每次都基于最新的位置）
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const order = dragOrder ?? list.map((w) => w.id)
  const orderRef = useRef(order)
  orderRef.current = order
  const [announce, setAnnounce] = useState('')
  const byId = new Map(list.map((w) => [w.id, w]))
  const rows = order.map((id) => byId.get(id)).filter((w): w is WorkspaceInfo => !!w)

  const move = async (id: string, pos: number) => {
    const name = byId.get(id)?.name ?? ''
    try {
      await reorder(id, pos)
      setAnnounce(`“${name}”移到第 ${pos + 1} 位，共 ${list.length} 个`)
    } catch (err) {
      toast(`调整顺序失败：${workspaceError(err)}`, 'error')
    }
  }
  const dropped = (id: string) => {
    const pos = orderRef.current.indexOf(id)
    // move 在第一个 await 之前就更新了 store 里的顺序，所以紧接着清掉拖动顺序不会闪回旧顺序
    if (pos >= 0 && pos !== list.findIndex((w) => w.id === id)) void move(id, pos)
    setDragOrder(null)
  }

  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.workspaces} testId="workspaces-page">
      <p className="settings-desc">每个工作空间是一套互相独立的笔记库，有自己的笔记、搜索、标签和回收站。</p>
      <Group
        title="全部工作空间"
        footer={
          list.length > 1 ? '拖动左侧的把手调整顺序；用键盘时聚焦把手，按上下方向键移动。顺序同样用于侧栏的切换列表。' : undefined
        }
      >
        <Reorder.Group
          as="ul"
          axis="y"
          values={order}
          onReorder={(next) => {
            orderRef.current = next
            setDragOrder(next)
          }}
          className="settings-list ws-list"
          aria-label="工作空间列表"
          data-testid="workspace-list"
        >
          {rows.map((w, i) => (
            <WorkspaceRow
              key={w.id}
              ws={w}
              index={i}
              total={rows.length}
              isCurrent={w.id === current}
              onMove={(pos) => void move(w.id, pos)}
              onDropped={() => dropped(w.id)}
            />
          ))}
        </Reorder.Group>
        <div className="ws-live visually-hidden" role="status" aria-live="polite">
          {announce}
        </div>
      </Group>
      <Group>
        <ActionRow icon={<Plus size={17} aria-hidden="true" />} onClick={() => void createWorkspace()} data-testid="workspace-create">
          新建工作空间…
        </ActionRow>
      </Group>
    </SettingsPage>
  )
}

function WorkspaceRow({
  ws,
  index,
  total,
  isCurrent,
  onMove,
  onDropped,
}: {
  ws: WorkspaceInfo
  index: number
  total: number
  isCurrent: boolean
  onMove: (pos: number) => void
  onDropped: () => void
}) {
  const controls = useDragControls()
  const [isDragging, setDragging] = useState(false)
  const key = (e: KeyboardEvent) => {
    const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? total - 1 : -1
    if (to < 0) return
    e.preventDefault()
    if (to !== index && to < total) onMove(to)
  }
  return (
    <Reorder.Item
      as="li"
      value={ws.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false)
        onDropped()
      }}
      className={`ws-row${isDragging ? ' is-dragging' : ''}`}
      data-testid="workspace-row"
      data-workspace={ws.id}
    >
      {total > 1 && (
        <button
          type="button"
          className="ws-handle hit-expand"
          aria-label={`调整“${ws.name}”的顺序，现在第 ${index + 1} 位`}
          title="拖动调整顺序，或按上下方向键"
          data-testid="workspace-handle"
          onPointerDown={(e) => {
            e.preventDefault()
            controls.start(e)
          }}
          onKeyDown={key}
        >
          <GripVertical size={18} aria-hidden="true" />
        </button>
      )}
      <NavRow
        to={['workspaces', ws.id]}
        label={
          <span className="ws-name">
            {ws.name}
            {isCurrent && <span className="ws-current">当前</span>}
          </span>
        }
        meta={`${ws.note_count} 篇笔记`}
      />
    </Reorder.Item>
  )
}

/* ---------------- 单个工作空间 ---------------- */

export function WorkspacePage({ sub, id }: { sub: string[]; id: string }) {
  const list = useWorkspace((s) => s.list)
  const current = useWorkspace((s) => s.current)
  const tokens = useSettingsData((s) => s.tokens)
  // 删除后列表里已经没有它，但退出动画期间仍显示原来的内容
  const last = useRef<WorkspaceInfo | null>(null)
  const found = list.find((w) => w.id === id) ?? null
  if (found) last.current = found
  const ws = found ?? last.current

  if (!ws || ws.id !== id) {
    return (
      <SettingsPage sub={sub} title={SECTION_TITLE.workspaces}>
        <EmptyState icon={<Layers size={28} strokeWidth={1.5} />} title="找不到这个工作空间">
          它可能已经被删除
        </EmptyState>
      </SettingsPage>
    )
  }

  const isDefault = isDefaultWorkspace(ws.id)
  const isCurrent = ws.id === current
  const bound = (tokens ?? []).filter((t) => t.workspace === ws.id)

  const rename = async () => {
    const name = await promptDialog({
      title: '重命名工作空间',
      label: '名称',
      initial: ws.name,
      confirmLabel: '保存',
      validate: invalidWorkspaceName,
    })
    if (name === null || name.trim() === ws.name) return
    try {
      await useWorkspace.getState().rename(ws.id, name.trim())
      toast('已重命名', 'success')
    } catch (err) {
      toast(`重命名失败：${workspaceError(err)}`, 'error')
    }
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `删除工作空间“${ws.name}”？`,
      message: (
        <div className="ws-confirm" data-testid="workspace-delete-confirm">
          <p>
            这个工作空间的 {ws.note_count} 篇笔记、附件、回收站和助手对话不会被直接删除：整个目录会被移到服务器数据目录的{' '}
            <code>trash-workspaces/</code> 下，你可以在服务器上手动取回或清理。
          </p>
          <p>
            {bound.length
              ? `绑定它的 ${bound.length} 个 API token（${bound.map((t) => t.name).join('、')}）会立即作废，用它们的 agent 无法再访问。`
              : '没有 API token 绑定它。'}
          </p>
          <p>{isCurrent ? `你现在正在使用它，删除后会回到“${nameOf(DEFAULT_WORKSPACE)}”。` : '你的其他工作空间不受影响。'}</p>
        </div>
      ),
      confirmLabel: '删除',
      danger: true,
      initialFocus: 'cancel',
    })
    if (!ok) return
    try {
      const revoked = await useWorkspace.getState().remove(ws.id)
      toast(`已删除“${ws.name}”${revoked ? `，作废了 ${revoked} 个 token` : ''}`, 'success')
      void useSettingsData.getState().loadTokens()
      void useSettingsData.getState().loadAudit()
      // 删除的是当前工作空间时，store 已经带着页面回到默认工作空间的列表
      if (!isCurrent) settingsBack(sub)
    } catch (err) {
      toast(`删除失败：${workspaceError(err)}`, 'error')
    }
  }

  return (
    <SettingsPage sub={sub} title={ws.name} testId="workspace-detail">
      <Group>
        <InfoRow label="名称">{ws.name}</InfoRow>
        <InfoRow label="笔记">{ws.note_count} 篇</InfoRow>
        <InfoRow label="类型">{ws.external ? '外部目录' : '内置位置'}</InfoRow>
        {isCurrent && <InfoRow label="状态">正在使用</InfoRow>}
      </Group>
      <Group title="位置" footer={ws.external ? '笔记文件所在的目录（服务器上的绝对路径）。' : '笔记文件所在的位置，相对服务器的数据目录。'}>
        <div className="settings-row">
          <CopyField value={ws.path || (isDefault ? 'vault' : `workspaces/${ws.id}/vault`)} label="路径" testId="workspace-path" />
        </div>
      </Group>
      <Group>
        <ActionRow icon={<Pencil size={17} aria-hidden="true" />} onClick={() => void rename()} data-testid="workspace-rename">
          重命名…
        </ActionRow>
        {!isCurrent && (
          <ActionRow
            icon={<Repeat size={17} aria-hidden="true" />}
            onClick={() => void useWorkspace.getState().switchTo(ws.id)}
            data-testid="workspace-switch"
          >
            切换到这个工作空间
          </ActionRow>
        )}
      </Group>
      <Group footer={isDefault ? '默认工作空间不能删除，只能改名。' : '目录会移到服务器数据目录的 trash-workspaces/ 下，不会直接删除。'}>
        <ActionRow
          danger
          icon={<Trash2 size={17} aria-hidden="true" />}
          disabled={isDefault}
          onClick={() => void remove()}
          data-testid="workspace-delete"
        >
          删除工作空间…
        </ActionRow>
      </Group>
    </SettingsPage>
  )
}

function nameOf(id: string): string {
  return useWorkspace.getState().list.find((w) => w.id === id)?.name ?? '笔记'
}

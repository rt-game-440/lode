import { type MenuEntry, openMenu, promptDialog } from '../../components/overlays'
import { deviceName, guessDeviceName, setDeviceName } from '../../lib/device'
import { useUI } from '../../stores/ui'
import { sync, useSync } from '../../sync/engine'

const LABEL = {
  synced: '已同步',
  syncing: '同步中',
  offline: '离线',
  conflict: '有冲突',
} as const

/** 同步状态：已同步 / 同步中 / 离线（N 项待同步）/ 有冲突。点击列出冲突副本和本机设备名。 */
export function SyncIndicator() {
  const status = useSync((s) => s.status)
  const pending = useSync((s) => s.pending)
  const conflicts = useSync((s) => s.conflicts)
  const text = status === 'offline' && pending ? `离线（${pending} 项待同步）` : LABEL[status]

  const showMenu = (el: HTMLElement) => {
    const navigate = useUI.getState().navigate
    const items: MenuEntry[] = conflicts.map((c) => ({
      label: `冲突副本：${c.copyPath.split('/').pop()!.replace(/\.md$/i, '')}`,
      run: () => {
        sync.dismissConflict(c.copyId)
        navigate({ view: 'note', id: c.copyId })
      },
    }))
    if (items.length) items.push('separator')
    items.push({
      label: `本机设备名：${deviceName()}`,
      run: async () => {
        const name = await promptDialog({
          title: '本机设备名',
          label: '冲突副本的文件名会带上设备名；留空则按浏览器自动识别',
          initial: deviceName(),
          placeholder: guessDeviceName(navigator.userAgent),
          confirmLabel: '保存',
        })
        if (name !== null) setDeviceName(name)
      },
    })
    openMenu(el, items)
  }

  return (
    <button
      className={`sync-status is-${status}`}
      data-testid="sync-status"
      aria-live="polite"
      title="同步状态"
      onClick={(e) => showMenu(e.currentTarget)}
    >
      <span className="sync-dot" aria-hidden="true" />
      {text}
    </button>
  )
}

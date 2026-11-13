// 把文件树里的条目拖到侧栏顶部的工作空间切换器上（#72）：悬停片刻展开工作空间列表，
// 放到某个工作空间上移动到它的根目录，按住 Alt/Option 放下为复制；Esc 取消。
import { type DragEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TransferItem } from '../../api/types'
import { useUI } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { useSync } from '../../sync/engine'
import { type TransferMode, transferByDrop } from './transfer'
import './transfer.css'

/** 拖动数据里放要传送的条目（JSON 数组，多选时是全部选中项）。 */
export const ITEMS_TYPE = 'application/x-lode-items'

/** 悬停多久展开工作空间列表 */
const OPEN_DELAY = 450
/** 离开切换器和列表多久后收起（从切换器移到列表的途中会短暂离开） */
const CLOSE_DELAY = 250

export function setDragItems(dt: DataTransfer, items: TransferItem[]) {
  dt.setData(ITEMS_TYPE, JSON.stringify(items))
}

function readDragItems(dt: DataTransfer): TransferItem[] {
  try {
    const v = JSON.parse(dt.getData(ITEMS_TYPE) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

const isOurs = (e: DragEvent) => e.dataTransfer.types.includes(ITEMS_TYPE)

/**
 * 工作空间切换器的拖放：返回绑在切换器按钮上的事件、是否高亮，以及展开的工作空间列表（渲染到 body）。
 */
export function useSwitcherDrop(anchor: RefObject<HTMLElement | null>) {
  const list = useWorkspace((s) => s.list)
  const current = useWorkspace((s) => s.current)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState<string | null>(null)
  const [copy, setCopy] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 本次拖动已按 Esc 取消：之后的放下都忽略 */
  const cancelled = useRef(false)
  /** 拖动中按下的 Alt：拖放事件的 altKey 之外再看键盘事件（有的环境里拖放事件不带修饰键） */
  const altHeld = useRef(false)
  const enabled = list.length > 1
  const altOf = (e: DragEvent) => e.altKey || altHeld.current

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    openTimer.current = closeTimer.current = null
  }
  const reset = () => {
    clearTimers()
    setHover(false)
    setOpen(false)
    setOver(null)
  }

  // 新的拖动开始时清掉取消标记；拖动结束（放下或取消）时收起；拖动中按 Esc 取消
  useEffect(() => {
    const onStart = () => {
      cancelled.current = false
      altHeld.current = false
    }
    const onEnd = () => {
      altHeld.current = false
      reset()
    }
    const onAlt = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      altHeld.current = e.type === 'keydown'
      if (open) setCopy(altHeld.current)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (!hover && !open)) return
      e.preventDefault()
      e.stopPropagation()
      cancelled.current = true
      reset()
    }
    window.addEventListener('dragstart', onStart, true)
    window.addEventListener('dragend', onEnd, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onAlt, true)
    window.addEventListener('keyup', onAlt, true)
    return () => {
      window.removeEventListener('keydown', onAlt, true)
      window.removeEventListener('keyup', onAlt, true)
      window.removeEventListener('dragstart', onStart, true)
      window.removeEventListener('dragend', onEnd, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [hover, open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearTimers, [])

  const stay = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const leaveSoon = () => {
    stay()
    closeTimer.current = setTimeout(reset, CLOSE_DELAY)
  }

  const accepts = (e: DragEvent) => enabled && !cancelled.current && isOurs(e)

  const switcherProps = {
    onDragEnter: (e: DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      stay()
      setHover(true)
      if (!open && !openTimer.current) openTimer.current = setTimeout(() => ((openTimer.current = null), setOpen(true)), OPEN_DELAY)
    },
    onDragOver: (e: DragEvent) => {
      if (!accepts(e)) return
      // 放在切换器本身上不做事：要放到展开的列表里的某个工作空间上
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
      setCopy(altOf(e))
    },
    onDragLeave: (e: DragEvent) => {
      if (!isOurs(e) || e.currentTarget.contains(e.relatedTarget as Node)) return
      if (openTimer.current && !open) {
        clearTimeout(openTimer.current)
        openTimer.current = null
      }
      leaveSoon()
    },
    onDrop: (e: DragEvent) => {
      if (!isOurs(e)) return
      e.preventDefault()
    },
  }

  const itemProps = (id: string) => ({
    onDragEnter: (e: DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      stay()
      setCopy(altOf(e))
      if (id !== current) setOver(id)
    },
    onDragOver: (e: DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      stay()
      setCopy(altOf(e))
      if (id === current) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      e.dataTransfer.dropEffect = altOf(e) ? 'copy' : 'move'
      if (over !== id) setOver(id)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return
      setOver((o) => (o === id ? null : o))
    },
    onDrop: (e: DragEvent) => {
      if (!isOurs(e)) return
      e.preventDefault()
      const items = readDragItems(e.dataTransfer)
      const mode: TransferMode = altOf(e) ? 'copy' : 'move'
      const ok = !cancelled.current && id !== current
      reset()
      if (!ok || !items.length) return
      if (useSync.getState().status === 'offline') {
        useUI.getState().toast({ message: '需要联网才能在工作空间之间移动或复制', tone: 'error' })
        return
      }
      void transferByDrop(items, id, mode)
    },
  })

  let dropList: ReactNode = null
  if (open && anchor.current) {
    const r = anchor.current.getBoundingClientRect()
    dropList = createPortal(
      <div
        className="ws-drop-list"
        role="list"
        aria-label="拖放到工作空间"
        style={{ left: r.left, top: r.bottom + 4 }}
        data-testid="workspace-drop-list"
        onDragEnter={stay}
        onDragOver={(e) => {
          if (accepts(e)) stay()
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) leaveSoon()
        }}
      >
        <div className="ws-drop-heading">{copy ? '复制到' : '移动到'}</div>
        {list.map((w) => (
          <div
            key={w.id}
            role="listitem"
            className={`ws-drop-item${w.id === current ? ' is-current' : ''}${over === w.id ? ' is-over' : ''}`}
            aria-disabled={w.id === current || undefined}
            data-testid={`workspace-drop-${w.id}`}
            {...itemProps(w.id)}
          >
            <span className="ws-drop-name">{w.name}</span>
            <span className="ws-drop-hint">{w.id === current ? '当前' : over === w.id ? (copy ? '复制' : '移动') : ''}</span>
          </div>
        ))}
        <div className="ws-drop-foot">按住 Alt（⌥）放下为复制，Esc 取消</div>
      </div>,
      document.body,
    )
  }

  return { switcherProps: enabled ? switcherProps : {}, highlight: hover || open, dropList }
}

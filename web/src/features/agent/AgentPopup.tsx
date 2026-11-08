import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { BottomSheet } from '../../components/BottomSheet'
import { usePop } from '../../components/usePop'
import { useUI } from '../../stores/ui'
import { springSnappy } from '../../styles/tokens/motion'
import { AgentPanel } from './AgentPanel'
import './agent-popup.css'

/** 笔记页标题栏上助手按钮的选择器：桌面弹窗从它附近弹出，关闭后焦点回到它 */
const TRIGGER = '.editor-bar button[aria-label="助手"]'

/**
 * 笔记页上的助手弹窗（#20）。当前笔记作为上下文，笔记页留在下面，关闭后原样回到笔记。
 * - 桌面：浮在编辑区上方的面板，非模态（没有遮罩，编辑区仍可操作），从助手按钮附近弹出；
 * - 手机：底部弹出的半屏面板（BottomSheet），可以拖到全屏或向下关闭。
 * “展开”按钮跳到整页助手，接着同一个会话（会话状态在 useAgent 里，与展示它的组件无关）。
 */
export function AgentPopup({ mobile, contextNoteId }: { mobile: boolean; contextNoteId: string | null }) {
  const open = useUI((s) => s.agentPopup)
  const setOpen = useUI((s) => s.setAgentPopup)
  const close = useCallback(() => setOpen(false), [setOpen])
  const expand = useCallback(() => useUI.getState().openAgent(), [])
  const actions = { onClose: close, onExpand: expand }

  if (mobile) {
    return (
      <BottomSheet open={open} onClose={close} label="助手">
        <AgentPanel contextNoteId={contextNoteId} mobile popup={actions} />
      </BottomSheet>
    )
  }
  return <AnimatePresence>{open && <FloatingPanel contextNoteId={contextNoteId} actions={actions} />}</AnimatePresence>
}

function FloatingPanel({
  contextNoteId,
  actions,
}: {
  contextNoteId: string | null
  actions: { onClose: () => void; onExpand: () => void }
}) {
  const root = useRef<HTMLDivElement>(null)
  /** 弹出和收回的原点：助手按钮中心相对面板的位置 */
  const [origin, setOrigin] = useState('100% 0')
  const pop = usePop({ scale: 0.92, y: -6 })

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const trigger = document.querySelector<HTMLElement>(TRIGGER)
    const parent = el.offsetParent
    if (trigger && parent) {
      // 面板此刻带着入场的缩放，用不带变换的 offsetLeft / offsetTop 算位置
      const t = trigger.getBoundingClientRect()
      const p = parent.getBoundingClientRect()
      setOrigin(`${t.left + t.width / 2 - p.left - el.offsetLeft}px ${t.top + t.height / 2 - p.top - el.offsetTop}px`)
    }
    // 非模态：不拦截 Tab，只在打开时把焦点移进来（有输入框时由 autoFocus 负责），关闭后回到原来的位置
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    return () => {
      const a = document.activeElement
      if (!a || a === document.body || el.contains(a)) (trigger?.isConnected ? trigger : before)?.focus({ preventScroll: true })
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 输入法选词、已被内部处理（例如关闭下拉）的 Esc 不算
    if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) {
      e.stopPropagation()
      actions.onClose()
    }
  }

  return (
    <motion.div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-label="助手"
      tabIndex={-1}
      className="agent-popup"
      style={{ transformOrigin: origin }}
      {...pop}
      transition={springSnappy}
      onKeyDown={onKeyDown}
      data-testid="agent-popup"
    >
      <AgentPanel contextNoteId={contextNoteId} mobile={false} popup={actions} focusInput />
    </motion.div>
  )
}

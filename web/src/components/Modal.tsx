import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { fadeTransition, springDefault } from '../styles/tokens/motion'
import { usePop } from './usePop'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 模态层的焦点管理：打开时把焦点移入（优先 autofocus 元素），Tab 在层内循环，
 * 关闭后焦点回到打开前的元素。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return
    const before = document.activeElement as HTMLElement | null
    if (!el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el
      first.focus({ preventScroll: true })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null && !x.closest('[inert]'))
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || cur === el)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [ref, active])
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** 无障碍名称；也可以用 labelledBy 指向标题 */
  label?: string
  labelledBy?: string
  className?: string
  children: ReactNode
}

/** 居中的模态面板：遮罩淡入，面板从略小的尺寸弹出；Esc 或点击遮罩关闭。 */
export function Modal({ open, onClose, label, labelledBy, className, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open)
  const pop = usePop({ scale: 0.96 }, { scale: 0.98 })
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            aria-labelledby={labelledBy}
            tabIndex={-1}
            className={`modal${className ? ` ${className}` : ''}`}
            {...pop}
            transition={springDefault}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

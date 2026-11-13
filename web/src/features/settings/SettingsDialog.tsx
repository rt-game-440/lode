import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { useFocusTrap } from '../../components/Modal'
import { IconButton } from '../../components/ui'
import { usePop } from '../../components/usePop'
import { useUI } from '../../stores/ui'
import { fadeTransition, springDefault } from '../../styles/tokens/motion'
import { isTypingTarget } from '../shell/ShortcutsDialog'
import { SettingsView } from './SettingsView'
import { closeSettings, settingsBack } from './nav'
import './settings-dialog.css'

/**
 * 桌面端的设置：居中的浮窗，背后是半透明遮罩，下面的页面保持原样（见 AppShell 里的 underRoute）。
 * 内部仍是 SettingsView 的多级导航；地址仍是 /settings/...，浏览器后退关闭浮窗。
 * 关闭：右上角按钮、点遮罩、Esc（输入框里的 Esc 不关闭）。返回上一级：顶部返回按钮、Backspace、Ctrl/Cmd+[。
 * 浮窗里再弹出的对话框和菜单挂在浮窗外，自己处理 Esc（只关最上层）。
 */
export function SettingsDialog() {
  const open = useUI((s) => s.route.view === 'settings')
  // 浮窗打开时下面的页面不可操作（读屏和 Tab 都到不了），关闭开始时立即恢复
  useEffect(() => {
    if (!open) return
    const shell = document.querySelector<HTMLElement>('.shell')
    shell?.setAttribute('inert', '')
    return () => shell?.removeAttribute('inert')
  }, [open])
  return <AnimatePresence>{open && <Panel key="settings-dialog" />}</AnimatePresence>
}

function Panel() {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, true)
  const pop = usePop({ scale: 0.96, y: 8 }, { scale: 0.98, y: 4 })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    const route = useUI.getState().route
    const sub = route.view === 'settings' ? (route.sub ?? []) : []
    const typing = isTypingTarget(e.target)
    if (e.key === 'Escape') {
      // 正在输入的框里 Esc 不关浮窗
      if (typing) return
      e.stopPropagation()
      closeSettings()
    } else if (e.key === 'Backspace' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && sub.length > 0) {
      e.preventDefault()
      settingsBack(sub)
    } else if (e.key === '[' && (e.ctrlKey || e.metaKey) && sub.length > 0) {
      e.preventDefault()
      settingsBack(sub)
    }
  }

  return (
    <motion.div
      className="scrim settings-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fadeTransition}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeSettings()
      }}
    >
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        className="settings-dialog"
        data-testid="settings-dialog"
        {...pop}
        transition={springDefault}
        onKeyDown={onKeyDown}
      >
        <SettingsView mobile={false} dialog />
        <IconButton label="关闭设置" className="settings-dialog-close" onClick={closeSettings} data-testid="settings-close">
          <X size={18} />
        </IconButton>
      </motion.div>
    </motion.div>
  )
}

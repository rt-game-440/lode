import { AnimatePresence, motion } from 'motion/react'
import { Check, X } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useUI } from '../stores/ui'
import { fadeOutQuick, fadeTransition, springDefault, springSnappy } from '../styles/tokens/motion'
import { Button, TextField } from './ui'
import { useFocusTrap } from './Modal'
import { usePop } from './usePop'

/* ---------- 对话框：prompt / confirm ---------- */

interface PromptRequest {
  kind: 'prompt'
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  /** 选中初始值的前 n 个字符（例如不选中扩展名） */
  selectLength?: number
  validate?: (value: string) => string | null
  resolve: (v: string | null) => void
}

interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** 默认焦点：默认在确认按钮上；破坏性操作可设为取消，避免回车误确认 */
  initialFocus?: 'cancel' | 'confirm'
  resolve: (ok: boolean) => void
}

type DialogRequest = PromptRequest | ConfirmRequest

const useDialogStore = create<{ current: DialogRequest | null }>(() => ({ current: null }))

/** 打开新对话框前，把仍在显示的对话框按取消处理。 */
function show(req: DialogRequest) {
  const cur = useDialogStore.getState().current
  if (cur) {
    if (cur.kind === 'prompt') cur.resolve(null)
    else cur.resolve(false)
  }
  useDialogStore.setState({ current: req })
}

export function promptDialog(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => show({ ...opts, kind: 'prompt', resolve }))
}

export function confirmDialog(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => show({ ...opts, kind: 'confirm', resolve }))
}

function closeDialog() {
  useDialogStore.setState({ current: null })
}

function PromptBody({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial ?? '')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, req.selectLength ?? el.value.length)
  }, [req])

  const submit = () => {
    const err = req.validate?.(value) ?? null
    if (err) {
      setError(err)
      return
    }
    req.resolve(value)
    closeDialog()
  }

  return (
    <form
      className="dialog"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <h2 className="dialog-title" id="dialog-title">
        {req.title}
      </h2>
      <TextField
        ref={input}
        label={req.label}
        placeholder={req.placeholder}
        value={value}
        error={error}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
      />
      <div className="dialog-actions">
        <Button
          variant="secondary"
          onClick={() => {
            req.resolve(null)
            closeDialog()
          }}
        >
          取消
        </Button>
        <Button variant="primary" type="submit">
          {req.confirmLabel ?? '确定'}
        </Button>
      </div>
    </form>
  )
}

function ConfirmBody({ req }: { req: ConfirmRequest }) {
  const ok = useRef<HTMLButtonElement>(null)
  const cancelBtn = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => (req.initialFocus === 'cancel' ? cancelBtn : ok).current?.focus(), [req])
  return (
    <div className="dialog">
      <h2 className="dialog-title" id="dialog-title">
        {req.title}
      </h2>
      {req.message && <div className="dialog-message">{req.message}</div>}
      <div className="dialog-actions">
        <Button
          ref={cancelBtn}
          variant="secondary"
          onClick={() => {
            req.resolve(false)
            closeDialog()
          }}
        >
          取消
        </Button>
        <Button
          ref={ok}
          variant={req.danger ? 'danger' : 'primary'}
          onClick={() => {
            req.resolve(true)
            closeDialog()
          }}
        >
          {req.confirmLabel ?? '确定'}
        </Button>
      </div>
    </div>
  )
}

function cancel(req: DialogRequest) {
  if (req.kind === 'prompt') req.resolve(null)
  else req.resolve(false)
  closeDialog()
}

export function DialogHost() {
  const req = useDialogStore((s) => s.current)
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, !!req)
  const pop = usePop({ scale: 0.96, y: 8 }, { scale: 0.98, y: 4 })
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cancel(req)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          className="scrim"
          key="dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) cancel(req)
          }}
        >
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            tabIndex={-1}
            {...pop}
            transition={springDefault}
            style={{ width: 'min(26rem, 100%)' }}
          >
            {req.kind === 'prompt' ? <PromptBody req={req} /> : <ConfirmBody req={req} />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------- 右键 / 更多菜单 ---------- */

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  /** 单选菜单：true 表示当前项（打勾）、false 表示可选项；不传则是普通菜单项 */
  checked?: boolean
  /** 右侧的简短提示（例如模型的能力） */
  hint?: string
  run: () => void
}
/** 分组标题：不可聚焦，只起分隔和说明作用 */
export interface MenuHeading {
  heading: string
}
export type MenuEntry = MenuItem | MenuHeading | 'separator'

interface MenuState {
  /**
   * above：空间不够向上翻转时，菜单底边对齐的位置（触发元素的上沿，或点击点）。
   * anchor：触发元素；再次点击它时切换关闭，Esc 关闭后焦点回到它。
   */
  open: { x: number; y: number; above: number; items: MenuEntry[]; anchor: HTMLElement | null } | null
}

const useMenuStore = create<MenuState>(() => ({ open: null }))

/** 在 (x, y) 打开菜单；传入触发元素时从元素下方弹出，下方空间不够时改到元素上方。再次点击已打开菜单的触发元素会关闭它。 */
export function openMenu(at: { x: number; y: number } | HTMLElement, items: MenuEntry[]) {
  const anchor = at instanceof HTMLElement ? at : null
  const cur = useMenuStore.getState().open
  if (anchor && cur?.anchor === anchor) {
    closeMenu()
    anchor.focus()
    return
  }
  let x: number
  let y: number
  let above: number
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    x = r.left
    y = r.bottom + 4
    above = r.top - 4
  } else {
    const p = at as { x: number; y: number }
    x = p.x
    y = p.y
    above = p.y - 8
  }
  useMenuStore.setState({ open: { x, y, above, items, anchor } })
}

export function closeMenu() {
  useMenuStore.setState({ open: null })
}

/** 外部点击只关闭菜单：吞掉随后的这一次 click，不让被点到的元素响应。pointerup 之后若没有 click（例如拖动），超时后自动撤下。 */
function swallowNextClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 1000)
}

export function MenuHost() {
  const menuPop = usePop({ scale: 0.96 }, { scale: 0.98 }, { transition: fadeOutQuick })
  const open = useMenuStore((s) => s.open)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null)

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null)
      return
    }
    const r = ref.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.max(8, Math.min(open.x, vw - r.width - 8))
    const flipUp = open.y + r.height > vh - 8
    const top = flipUp ? Math.max(8, open.above - r.height) : open.y
    setPos({ left, top, origin: `${open.x - left}px ${flipUp ? '100%' : '0'}` })
  }, [open])

  // 定位完成、菜单可见之后再聚焦（visibility: hidden 的元素聚焦不了）。单选菜单先聚焦当前项，其余聚焦第一项
  useLayoutEffect(() => {
    if (!pos || !ref.current) return
    const first = ref.current.querySelector<HTMLButtonElement>('.menu-item[aria-checked="true"]') ?? ref.current.querySelector<HTMLButtonElement>('.menu-item')
    first?.focus()
    first?.scrollIntoView({ block: 'nearest' })
  }, [pos])

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      // 触发元素上的按下交给随后的 click 处理（切换），这里不关，否则会先关再被 click 重新打开
      if (open.anchor?.contains(target)) return
      closeMenu()
      swallowNextClick()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMenu()
        if (open.anchor?.isConnected) open.anchor.focus()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? [])
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="menu"
          className="menu"
          key={`${open.x},${open.y}`}
          style={{ left: pos?.left ?? open.x, top: pos?.top ?? open.y, transformOrigin: pos?.origin ?? '0 0', visibility: pos ? 'visible' : 'hidden' }}
          {...menuPop}
          transition={springSnappy}
          onContextMenu={(e) => e.preventDefault()}
        >
          {open.items.map((it, i) =>
            it === 'separator' ? (
              <div key={`sep-${i}`} className="menu-sep" role="separator" />
            ) : 'heading' in it ? (
              <div key={`head-${i}`} className="menu-heading" role="presentation">
                {it.heading}
              </div>
            ) : (
              <button
                key={`${i}-${it.label}`}
                role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={it.checked}
                className={`menu-item${it.danger ? ' is-danger' : ''}`}
                onClick={() => {
                  closeMenu()
                  it.run()
                }}
              >
                {it.icon}
                <span className="menu-label">{it.label}</span>
                {it.hint && <span className="menu-hint">{it.hint}</span>}
                {it.checked !== undefined && <Check size={14} className="menu-check" aria-hidden="true" style={{ visibility: it.checked ? 'visible' : 'hidden' }} />}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------- 提示条 ---------- */

export function ToastHost() {
  const toastPop = usePop({ y: 16, scale: 0.96 }, { y: 8, scale: 0.98 })
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast${t.tone === 'error' ? ' is-error' : ''}`}
            {...toastPop}
            transition={springDefault}
          >
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action?.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.persistent && (
              <button className="toast-close" aria-label="关闭" onClick={() => dismiss(t.id)}>
                <X size={14} />
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

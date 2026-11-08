import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { usePop } from '../../components/usePop'
import type { PageWidth } from '../../lib/noteAppearance'
import { useNoteAppearance } from '../../stores/noteAppearance'
import { fadeOutQuick, springSnappy } from '../../styles/tokens/motion'
import { applyNoteAppearance } from './cm/appearance'
import { editorRef } from './editorRef'
import './appearance.css'

// 笔记“更多操作”菜单里的“外观和布局”：从同一个按钮下方弹出的非模态面板，改动立即生效、面板保持打开，
// Esc 或点面板外关闭。页宽、字体写进笔记的 front matter（cm/appearance）。

const usePanel = create<{ anchor: HTMLElement | null }>(() => ({ anchor: null }))

export function openAppearancePanel(anchor: HTMLElement) {
  usePanel.setState({ anchor })
}

export function closeAppearancePanel() {
  usePanel.setState({ anchor: null })
}

export const WIDTH_LABEL: Record<PageWidth, string> = { narrow: '窄', standard: '适中', wide: '宽' }

export function AppearancePanelHost({ mobile }: { mobile: boolean }) {
  const anchor = usePanel((s) => s.anchor)
  const ref = useRef<HTMLDivElement>(null)
  const pop = usePop({ scale: 0.96 }, { scale: 0.98 }, { transition: fadeOutQuick })
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null)
      return
    }
    const a = anchor.getBoundingClientRect()
    const r = ref.current.getBoundingClientRect()
    const right = Math.max(8, Math.min(window.innerWidth - a.right, window.innerWidth - r.width - 8))
    const top = Math.max(8, Math.min(a.bottom + 4, window.innerHeight - r.height - 8))
    setPos({ right, top })
  }, [anchor])

  // 定位完成、面板可见后，焦点进第一组的选中项
  const shown = !!pos
  useLayoutEffect(() => {
    if (shown) ref.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
  }, [shown])

  useEffect(() => {
    if (!anchor) return
    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) closeAppearancePanel()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeAppearancePanel()
      if (anchor.isConnected) anchor.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', closeAppearancePanel)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', closeAppearancePanel)
    }
  }, [anchor])

  // 离开笔记时关闭
  useEffect(() => closeAppearancePanel, [])

  return (
    <AnimatePresence>
      {anchor && (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label="外观和布局"
          className="appearance-panel"
          data-testid="appearance-panel"
          style={{ right: pos?.right ?? 8, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          {...pop}
          transition={springSnappy}
        >
          <AppearanceControls mobile={mobile} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function AppearanceControls({ mobile }: { mobile: boolean }) {
  const width = useNoteAppearance((s) => s.width)
  const set = (patch: Parameters<typeof applyNoteAppearance>[1]) => {
    if (editorRef.view) applyNoteAppearance(editorRef.view, patch)
  }
  return (
    <>
      {!mobile && (
        <Section title="页宽" id="appearance-width">
          <RadioGroup
            labelledBy="appearance-width"
            className="segmented appearance-width"
            value={width}
            options={(['narrow', 'standard', 'wide'] as const).map((w) => ({ value: w, label: WIDTH_LABEL[w] }))}
            itemClass={(on) => `segment${on ? ' is-selected' : ''}`}
            onChange={(w) => set({ width: w })}
          />
        </Section>
      )}
    </>
  )
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="appearance-section">
      <h3 className="appearance-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  )
}

interface RadioOption<T extends string> {
  value: T
  label: ReactNode
  /** 可访问名称（label 不是纯文字时） */
  name?: string
}

/** 单选组：左右方向键在选项间移动并选中，只有选中项在 Tab 序列里。 */
export function RadioGroup<T extends string>({
  labelledBy,
  className,
  value,
  options,
  itemClass,
  onChange,
}: {
  labelledBy: string
  className: string
  value: T
  options: RadioOption<T>[]
  itemClass: (selected: boolean) => string
  onChange: (v: T) => void
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + step + options.length) % options.length]
    onChange(next.value)
    const buttons = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
    buttons[options.indexOf(next)]?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={className} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.name}
          tabIndex={o.value === value ? 0 : -1}
          className={itemClass(o.value === value)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

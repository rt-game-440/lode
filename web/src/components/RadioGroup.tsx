import type { KeyboardEvent, ReactNode } from 'react'

export interface RadioOption<T extends string> {
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

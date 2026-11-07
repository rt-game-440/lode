import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, forwardRef } from 'react'
import './ui.css'

type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, block, className, children, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', `btn-${variant}`, `btn-${size}`, block ? 'btn-block' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon}
      {children !== undefined && <span className="btn-label">{children}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

/** 只有图标的按钮：label 用作无障碍名称与悬停提示。 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={['icon-btn', `icon-btn-${size}`, active ? 'is-active' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
})

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string | null
  leading?: ReactNode
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, leading, className, id, ...rest },
  ref,
) {
  const fieldId = id ?? (label ? `f-${label}` : undefined)
  return (
    <div className={['field', error ? 'has-error' : '', className ?? ''].filter(Boolean).join(' ')}>
      {label && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className="field-box">
        {leading && <span className="field-leading">{leading}</span>}
        <input
          ref={ref}
          id={fieldId}
          className="field-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error && fieldId ? `${fieldId}-err` : undefined}
          {...rest}
        />
      </div>
      {error && (
        <p className="field-error" id={fieldId ? `${fieldId}-err` : undefined} role="alert">
          {error}
        </p>
      )}
    </div>
  )
})

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

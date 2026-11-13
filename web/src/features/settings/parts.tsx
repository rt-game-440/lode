import { ArrowLeft, ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { type ButtonHTMLAttributes, type MouseEvent, type ReactNode, createContext, useContext, useId } from 'react'
import { IconButton } from '../../components/ui'
import { copyText } from '../../lib/clipboard'
import { useUI } from '../../stores/ui'
import { PanelToggleSlot } from '../shell/PanelToggle'
import { openSettings, settingsBack } from './nav'
import { parentTitle, settingsPath } from './stack'

// 设置各级页面共用的部件：顶栏、分组卡片、可以点进去的行、复制框。

export const SettingsContext = createContext({ mobile: false, dialog: false })

/** 图标底色（tokens 里的 --color-tile-*，上面放白色图标）。 */
export type Tone = 'azure' | 'emerald' | 'amber' | 'violet' | 'slate' | 'indigo'

export function RowIcon({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`row-icon tone-${tone}`} aria-hidden="true">
      {children}
    </span>
  )
}

/**
 * 页面顶栏：子页面左侧是返回按钮（显示上一级的标题），标题居中，右侧放页面操作。
 * 首页在手机上返回笔记列表；桌面端侧栏收起时，左上角让位给浮动的展开侧栏按钮（#19）。
 */
function SettingsBar({ sub, title, actions }: { sub: string[]; title: string; actions?: ReactNode }) {
  const { mobile, dialog } = useContext(SettingsContext)
  const navigate = useUI((s) => s.navigate)
  const parent = parentTitle(sub)
  return (
    <header className="view-bar settings-bar">
      <div className="settings-bar-lead">
        {!mobile && !dialog && <PanelToggleSlot side="left" />}
        {sub.length > 0 ? (
          <button type="button" className="settings-back" aria-label={`返回${parent}`} onClick={() => settingsBack(sub)}>
            <ChevronLeft size={22} aria-hidden="true" />
            <span className="settings-back-label">{parent}</span>
          </button>
        ) : (
          mobile && (
            <IconButton label="返回" onClick={() => navigate({ view: 'home' })}>
              <ArrowLeft size={20} />
            </IconButton>
          )
        )}
      </div>
      <h1 className="view-title settings-bar-title" tabIndex={-1} data-stack-heading>
        {title}
      </h1>
      <div className="settings-bar-trail">{actions}</div>
    </header>
  )
}

/** 一级页面的框架：顶栏加可滚动的内容区。 */
export function SettingsPage({
  sub,
  title,
  actions,
  testId,
  children,
}: {
  sub: string[]
  title: string
  actions?: ReactNode
  testId?: string
  children: ReactNode
}) {
  return (
    <section className="view settings-page">
      <SettingsBar sub={sub} title={title} actions={actions} />
      <div className="view-body settings" data-testid={testId}>
        {children}
      </div>
    </section>
  )
}

/** iOS 风格的分组：小标题、圆角卡片、卡片下方的说明。 */
export function Group({ title, footer, children }: { title?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-group" aria-labelledby={title ? id : undefined}>
      {title && (
        <h2 id={id} className="settings-group-title">
          {title}
        </h2>
      )}
      <div className="settings-card">{children}</div>
      {footer && <p className="settings-footnote">{footer}</p>}
    </section>
  )
}

/** 普通点击在应用内导航；按住修饰键、中键等保留浏览器默认行为（新标签页打开）。 */
function linkClick(e: MouseEvent<HTMLAnchorElement>, to: string[]) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  openSettings(to)
}

/** 可以点进下一级的行：图标、名称、当前状态摘要和 ›。 */
export function NavRow({
  to,
  icon,
  label,
  value,
  meta,
  testId,
}: {
  to: string[]
  icon?: ReactNode
  label: ReactNode
  /** 右侧的状态摘要 */
  value?: ReactNode
  /** 名称下方的第二行说明 */
  meta?: ReactNode
  testId?: string
}) {
  return (
    <a className="nav-row" href={settingsPath(to)} onClick={(e) => linkClick(e, to)} data-testid={testId}>
      {icon}
      <span className="nav-row-main">
        <span className="nav-row-text">
          <span className="nav-row-label">{label}</span>
          {meta && <span className="settings-meta nav-row-meta">{meta}</span>}
        </span>
        {value !== undefined && value !== null && value !== '' && <span className="nav-row-value">{value}</span>}
        <ChevronRight className="nav-row-chevron" size={17} aria-hidden="true" />
      </span>
    </a>
  )
}

/** 整行是一个按钮的操作（添加、测试、删除）。 */
export function ActionRow({
  icon,
  danger,
  children,
  ...rest
}: { icon?: ReactNode; danger?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button type="button" className={`settings-row action-row${danger ? ' is-danger' : ''}`} {...rest}>
      {icon}
      <span>{children}</span>
    </button>
  )
}

/** 只读的一行：左边名称，右边值。 */
export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row info-row">
      <span className="info-row-label">{label}</span>
      <span className="info-row-value">{children}</span>
    </div>
  )
}

/** 复制并提示结果。 */
export async function copyWithToast(text: string, what: string) {
  const ok = await copyText(text)
  useUI.getState().toast(ok ? { message: `已复制${what}`, tone: 'success' } : { message: '复制失败，请手动选择复制', tone: 'error' })
}

export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div className="copy-field">
      <code className="copy-field-value" data-testid={testId}>
        {value}
      </code>
      <IconButton label={`复制${label}`} size="sm" onClick={() => void copyWithToast(value, label)}>
        <Copy size={15} />
      </IconButton>
    </div>
  )
}

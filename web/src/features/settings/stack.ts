/**
 * 设置的多级页面：路径、页面识别和导航栈的变化方向（纯函数，不依赖 React 和全局状态）。
 *
 * 路径是 /settings 之后的各段，每多一段就深一级：
 *   []                    设置首页
 *   ['appearance']        外观
 *   ['keyboard']          键盘
 *   ['agent']             助手
 *   ['agent', <供应商 id>] 单个供应商
 *   ['mcp']               MCP 接入
 *   ['tokens']            API token
 *   ['tokens', <token id>] 单个 token
 *   ['audit']             调用记录
 */

export type SettingsPageId =
  | 'root'
  | 'appearance'
  | 'keyboard'
  | 'agent'
  | 'provider'
  | 'mcp'
  | 'tokens'
  | 'token'
  | 'audit'

export interface SettingsPageRef {
  id: SettingsPageId
  /** 第二级页面的参数：供应商 id 或 token id */
  param?: string
}

/** 第一级页面（路径只有一段）及其标题；第二级页面的标题来自数据（供应商名、token 名）。 */
export const SECTION_TITLE = {
  appearance: '外观',
  keyboard: '键盘',
  agent: '助手',
  mcp: 'MCP 接入',
  tokens: 'API token',
  audit: '调用记录',
} as const

export const ROOT_TITLE = '设置'

type Section = keyof typeof SECTION_TITLE

/** 有第二级页面的分组，以及第二级页面的 id。 */
const DETAIL: Partial<Record<Section, SettingsPageId>> = { agent: 'provider', tokens: 'token' }

function isSection(s: string): s is Section {
  return Object.hasOwn(SECTION_TITLE, s)
}

export function settingsPage(sub: string[]): SettingsPageRef | null {
  if (sub.length === 0) return { id: 'root' }
  const [section, param, ...rest] = sub
  if (!isSection(section) || rest.length) return null
  if (param === undefined) return { id: section }
  const detail = DETAIL[section]
  return detail ? { id: detail, param } : null
}

/** 静态页面（首页和第一级）的标题；未知路径用“设置”。 */
export function staticTitle(sub: string[]): string {
  const s = sub[0]
  return sub.length === 1 && s !== undefined && isSection(s) ? SECTION_TITLE[s] : ROOT_TITLE
}

/** 返回按钮上显示的上一级标题。上一级总是首页或第一级页面。 */
export function parentTitle(sub: string[]): string {
  return staticTitle(sub.slice(0, -1))
}

/** 与 stores/ui 的 routePath 一致（单测保证两者相同）。 */
export function settingsPath(sub: string[]): string {
  return ['/settings', ...sub.map(encodeURIComponent)].join('/')
}

export function pathKey(sub: string[]): string {
  return sub.map(encodeURIComponent).join('/')
}

/** 当前路径的各级前缀：导航栈里从首页到当前页的每一层。 */
export function prefixes(sub: string[]): string[][] {
  return Array.from({ length: sub.length + 1 }, (_, i) => sub.slice(0, i))
}

function startsWith(a: string[], b: string[]): boolean {
  return b.length <= a.length && b.every((s, i) => a[i] === s)
}

/**
 * 从 prev 到 next 的变化：更深（next 以 prev 开头）是推入，回到祖先是推出，
 * 同级或不相关的页面直接替换，不做转场。
 */
export function stackChange(prev: string[], next: string[]): 'push' | 'pop' | 'replace' | 'none' {
  if (prev.length === next.length && startsWith(next, prev)) return 'none'
  if (startsWith(next, prev)) return 'push'
  if (startsWith(prev, next)) return 'pop'
  return 'replace'
}

/**
 * 返回按钮：上一条历史正好是上一级（从上一级推入进来的）时用 history.back()，
 * 和浏览器后退、Android 返回键的结果一致；直接打开或刷新进来的子页面则替换成上一级。
 */
export function backViaHistory(state: unknown, sub: string[]): boolean {
  const from = (state as { lodeFrom?: unknown } | null)?.lodeFrom
  return typeof from === 'string' && from === settingsPath(sub.slice(0, -1))
}

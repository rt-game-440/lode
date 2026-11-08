/**
 * 助手页的来源记录（#21）：从别的页面进入助手页时，把来源路径记在助手页这条历史项的 state 里。
 * 返回时有来源就 history.back()，结果与浏览器后退、Android 返回键、左缘返回手势完全一致；
 * 直接打开或刷新助手页没有来源，返回回到列表。
 */
const KEY = 'lodeAgentFrom'

/** 给助手页历史项的 state 附上来源路径。 */
export function withAgentFrom(state: unknown, from: string): Record<string, unknown> {
  const base = state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
  return { ...base, [KEY]: from }
}

/** 去掉来源记录（刷新后的助手页没有来源：上一条历史虽然还在，但不算“进入前的页面”）。 */
export function withoutAgentFrom(state: unknown): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {}
  delete base[KEY]
  return base
}

export function agentFrom(state: unknown): string | null {
  const v = (state as Record<string, unknown> | null)?.[KEY]
  return typeof v === 'string' && v.startsWith('/') && v !== '/agent' ? v : null
}

/** 助手页返回：有来源回到来源（history.back），没有回到列表。 */
export function agentBackAction(state: unknown): 'history' | 'home' {
  return agentFrom(state) ? 'history' : 'home'
}

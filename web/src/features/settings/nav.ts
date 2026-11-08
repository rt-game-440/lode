import { useUI } from '../../stores/ui'
import { backViaHistory } from './stack'

/** 进入设置的某一级页面（推入一条历史，并记下来源，供返回按钮判断）。 */
export function openSettings(sub: string[]) {
  const from = location.pathname
  useUI.getState().navigate({ view: 'settings', sub })
  if (location.pathname !== from) history.replaceState({ ...(history.state ?? {}), lodeFrom: from }, '')
}

/**
 * 返回上一级：返回按钮和左缘返回手势都走这里。
 * 从上一级推入进来的用 history.back()，结果和浏览器后退、Android 返回键一致；
 * 直接打开或刷新进来的子页面没有上一级的历史，替换成上一级。
 */
export function settingsBack(sub: string[]) {
  if (!sub.length) return
  if (backViaHistory(history.state, sub)) history.back()
  else useUI.getState().navigate({ view: 'settings', sub: sub.slice(0, -1) }, true)
}

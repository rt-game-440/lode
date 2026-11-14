import { splitWorkspacePath } from '../../lib/workspace'
import { settingsHistory, useUI } from '../../stores/ui'
import { backViaHistory } from './stack'

/** 进入设置的某一级页面（推入一条历史，并记下来源，供返回按钮判断）。 */
export function openSettings(sub: string[]) {
  const from = location.pathname
  useUI.getState().navigate({ view: 'settings', sub })
  // 记工作空间内的路径（不含 /w/<id> 前缀），与 settingsPath 比较
  if (location.pathname !== from) history.replaceState({ ...(history.state ?? {}), lodeFrom: splitWorkspacePath(from).rest }, '')
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

/**
 * 关闭桌面端的设置浮窗，回到打开前的地址：
 * 打开前还有一条应用内历史时，一次 history.go 退回去（浮窗里推入的各级都跳过，浏览器的前进还能重新打开）；
 * 直接访问 /settings/... 进来的没有“打开前”，把浮窗下面的页面（首页）替换进来。
 */
export function closeSettings() {
  const ui = useUI.getState()
  if (ui.route.view !== 'settings') return
  const { depth, entry } = settingsHistory(history.state)
  if (entry) {
    history.go(-(depth + 1))
    return
  }
  const under = ui.underRoute
  if (depth > 0) {
    // 先退到浮窗打开的那一条，再把它替换掉，不在历史里留下设置的各级
    const onPop = () => {
      window.removeEventListener('popstate', onPop)
      useUI.getState().navigate(under, true)
    }
    window.addEventListener('popstate', onPop)
    history.go(-depth)
    return
  }
  ui.navigate(under, true)
}

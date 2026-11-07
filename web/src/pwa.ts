/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register'
import { useUI } from './stores/ui'

/** 注册 service worker（缓存应用壳）；有新版本时提示刷新，由用户决定何时切换。 */
export function setupPWA() {
  if (!('serviceWorker' in navigator)) return
  const update = registerSW({
    onNeedRefresh() {
      useUI.getState().toast({
        message: '有新版本，点击刷新',
        persistent: true,
        action: { label: '刷新', run: () => void update(true) },
      })
    },
    // 浏览器只在页面导航时检查 SW 更新；安装到主屏的应用常从后台恢复而不导航，回到前台时主动检查一次
    onRegisteredSW(_url, reg) {
      if (!reg) return
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) void reg.update().catch(() => {})
      })
    },
  })
}

import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installViewportTracking } from './lib/viewport'
import { setupPWA } from './pwa'
import { applyFontSize, useDisplayPrefs } from './stores/displayPrefs'
import { applyTheme, useUI } from './stores/ui'
import './styles/global.css'

applyTheme(useUI.getState().theme)
applyFontSize(useDisplayPrefs.getState().fontSize)
setupPWA()
installViewportTracking()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 系统开启"减弱动态效果"时，位移和缩放动画直接跳到终点，只保留透明度过渡 */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)

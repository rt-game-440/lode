import { create } from 'zustand'

/**
 * 整体字号（#47）：按设备保存在 localStorage。
 * 只改根元素的 font-size（百分比，相对浏览器默认字号），界面和正文都以 rem 为基准，所以一起缩放；
 * 浏览器里调大了默认字号的用户，各档在那个基础上再缩放。单篇笔记只换字体，不改字号。
 */
export type FontSize = 'small' | 'standard' | 'large' | 'xlarge'
export const FONT_SIZES: FontSize[] = ['small', 'standard', 'large', 'xlarge']
export const FONT_SIZE_LABEL: Record<FontSize, string> = { small: '小', standard: '标准', large: '大', xlarge: '特大' }

const KEY = 'lode.display.fontSize'

function load(): FontSize {
  try {
    const v = localStorage.getItem(KEY) as FontSize | null
    return v && FONT_SIZES.includes(v) ? v : 'standard'
  } catch {
    return 'standard'
  }
}

/** 根元素上的 data-font-size 选中 global.css 里对应的档位；标准档不加属性 */
export function applyFontSize(s: FontSize) {
  const root = document.documentElement
  if (s === 'standard') root.removeAttribute('data-font-size')
  else root.setAttribute('data-font-size', s)
}

interface DisplayPrefs {
  fontSize: FontSize
  setFontSize: (s: FontSize) => void
}

export const useDisplayPrefs = create<DisplayPrefs>((set) => ({
  fontSize: load(),
  setFontSize: (s) => {
    try {
      if (s === 'standard') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, s)
    } catch {
      // 存储不可用时只在本次会话生效
    }
    applyFontSize(s)
    set({ fontSize: s })
  },
}))

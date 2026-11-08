import { create } from 'zustand'

// 编辑器偏好（仅存在本机 localStorage）。与设置页的界面分开，设置页迁移时只需调用这里。
const KEY = 'lode.editor.formatToolbar'
const TOC_KEY = 'lode.editor.tocRail'

function load(key: string, off: string): boolean {
  try {
    return localStorage.getItem(key) !== off
  } catch {
    return true
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时只在本次会话生效
  }
}

interface EditorPrefs {
  /** 桌面端是否显示格式顶栏 */
  formatToolbar: boolean
  setFormatToolbar: (show: boolean) => void
  /** 桌面端是否在正文右侧显示目录条（#47） */
  tocRail: boolean
  setTocRail: (show: boolean) => void
}

export const useEditorPrefs = create<EditorPrefs>((set) => ({
  formatToolbar: load(KEY, 'hidden'),
  setFormatToolbar: (show) => {
    store(KEY, show ? 'shown' : 'hidden')
    set({ formatToolbar: show })
  },
  tocRail: load(TOC_KEY, 'hidden'),
  setTocRail: (show) => {
    store(TOC_KEY, show ? 'shown' : 'hidden')
    set({ tocRail: show })
  },
}))

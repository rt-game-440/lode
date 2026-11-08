import { create } from 'zustand'

// 编辑器偏好（仅存在本机 localStorage）。与设置页的界面分开，设置页迁移时只需调用这里。
const KEY = 'lode.editor.formatToolbar'

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'hidden'
  } catch {
    return true
  }
}

interface EditorPrefs {
  /** 桌面端是否显示格式顶栏 */
  formatToolbar: boolean
  setFormatToolbar: (show: boolean) => void
}

export const useEditorPrefs = create<EditorPrefs>((set) => ({
  formatToolbar: load(),
  setFormatToolbar: (show) => {
    try {
      localStorage.setItem(KEY, show ? 'shown' : 'hidden')
    } catch {
      // 存储不可用时只在本次会话生效
    }
    set({ formatToolbar: show })
  },
}))

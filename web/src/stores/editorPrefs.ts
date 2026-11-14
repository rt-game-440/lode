import { create } from 'zustand'

// 编辑器偏好（仅存在本机 localStorage）。与设置页的界面分开，设置页迁移时只需调用这里。
const KEY = 'lode.editor.formatToolbar'
const TOC_KEY = 'lode.editor.tocRail'
const BROWSE_KEY = 'lode.editor.browseByDefault'
const SELECTION_KEY = 'lode.editor.selectionToolbar'

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

/** 默认关闭的开关：只有明确存了 on 才为真。 */
function loadOn(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'on'
  } catch {
    return false
  }
}

interface EditorPrefs {
  /** 桌面端是否显示格式顶栏 */
  formatToolbar: boolean
  setFormatToolbar: (show: boolean) => void
  /** 桌面端是否在正文右侧显示目录条（#47） */
  tocRail: boolean
  setTocRail: (show: boolean) => void
  /** 打开笔记时是否默认进入浏览模式（默认关闭） */
  browseByDefault: boolean
  setBrowseByDefault: (on: boolean) => void
  /** 选中文字时是否在选区附近浮出工具框（#73，默认开） */
  selectionToolbar: boolean
  setSelectionToolbar: (show: boolean) => void
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
  browseByDefault: loadOn(BROWSE_KEY),
  setBrowseByDefault: (on) => {
    store(BROWSE_KEY, on ? 'on' : 'off')
    set({ browseByDefault: on })
  },
  selectionToolbar: load(SELECTION_KEY, 'hidden'),
  setSelectionToolbar: (show) => {
    store(SELECTION_KEY, show ? 'shown' : 'hidden')
    set({ selectionToolbar: show })
  },
}))

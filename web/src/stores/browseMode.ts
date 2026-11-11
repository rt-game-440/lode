import { create } from 'zustand'

// 当前打开笔记的浏览模式（仅浏览：正文和标题不可编辑，只能阅读、点链接、勾选任务）。
// 只存在内存里，不写入笔记；切换笔记时由 EditorPane 按“打开笔记默认浏览”设置重置。
interface BrowseMode {
  browse: boolean
  setBrowse: (on: boolean) => void
  toggle: () => void
}

export const useBrowseMode = create<BrowseMode>((set, get) => ({
  browse: false,
  setBrowse: (on) => set({ browse: on }),
  toggle: () => set({ browse: !get().browse }),
}))

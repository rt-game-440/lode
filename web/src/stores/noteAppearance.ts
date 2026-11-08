import { create } from 'zustand'
import { DEFAULT_APPEARANCE, type NoteAppearance } from '../lib/noteAppearance'

/**
 * 当前打开的笔记的外观（来自它的 front matter，由编辑器扩展 cm/appearance 发布）。
 * animate 为 false 表示刚载入一篇笔记：页宽直接到位，不做过渡。
 */
interface NoteAppearanceState extends NoteAppearance {
  animate: boolean
  publish: (a: NoteAppearance, animate: boolean) => void
}

export const useNoteAppearance = create<NoteAppearanceState>((set) => ({
  ...DEFAULT_APPEARANCE,
  animate: false,
  publish: (a, animate) => set({ width: a.width, font: a.font, animate }),
}))

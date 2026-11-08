import { create } from 'zustand'
import type { Attachment } from '../api/agent'

/**
 * 助手输入框里还没发送的草稿（#21）。放在全局而不是输入框组件里：
 * 弹窗展开到助手页（或反过来）时输入框会换成另一个组件实例，草稿要跟着带过去。
 */
type Update<T> = T | ((prev: T) => T)
const apply = <T>(u: Update<T>, prev: T): T => (typeof u === 'function' ? (u as (p: T) => T)(prev) : u)

interface DraftState {
  text: string
  /** 是否带上当前笔记（默认带上，发送后恢复） */
  withContext: boolean
  mentions: string[]
  attachments: Attachment[]
  setText: (u: Update<string>) => void
  setWithContext: (u: Update<boolean>) => void
  setMentions: (u: Update<string[]>) => void
  setAttachments: (u: Update<Attachment[]>) => void
  clear: () => void
}

export const useAgentDraft = create<DraftState>((set) => ({
  text: '',
  withContext: true,
  mentions: [],
  attachments: [],
  setText: (u) => set((s) => ({ text: apply(u, s.text) })),
  setWithContext: (u) => set((s) => ({ withContext: apply(u, s.withContext) })),
  setMentions: (u) => set((s) => ({ mentions: apply(u, s.mentions) })),
  setAttachments: (u) => set((s) => ({ attachments: apply(u, s.attachments) })),
  clear: () => set({ text: '', withContext: true, mentions: [], attachments: [] }),
}))

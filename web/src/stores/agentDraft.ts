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
  /** 用户明确附上的笔记（@ 补全、点“附上当前笔记”） */
  mentions: string[]
  attachments: Attachment[]
  /**
   * 不再自动附上的笔记：用户在本次会话里移除过的，以及已经随消息发出的。
   * “当前笔记”只在第一次发送时自动附上，之后要用户点一下才附（#44）。
   * 换会话或新建会话时清空（见 stores/agent 的 open）。
   */
  suppressed: string[]
  setText: (u: Update<string>) => void
  setMentions: (u: Update<string[]>) => void
  setAttachments: (u: Update<Attachment[]>) => void
  suppress: (paths: string[]) => void
  /** 发送成功后清空草稿；suppressed 保留 */
  clear: () => void
  resetSuppressed: () => void
}

export const useAgentDraft = create<DraftState>((set) => ({
  text: '',
  mentions: [],
  attachments: [],
  suppressed: [],
  setText: (u) => set((s) => ({ text: apply(u, s.text) })),
  setMentions: (u) => set((s) => ({ mentions: apply(u, s.mentions) })),
  setAttachments: (u) => set((s) => ({ attachments: apply(u, s.attachments) })),
  suppress: (paths) => set((s) => ({ suppressed: [...new Set([...s.suppressed, ...paths])] })),
  clear: () => set({ text: '', mentions: [], attachments: [] }),
  resetSuppressed: () => set((s) => (s.suppressed.length ? { suppressed: [] } : s)),
}))

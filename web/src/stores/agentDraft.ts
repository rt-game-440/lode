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
  /**
   * 引用的正文片段（#73 选中文字后“问助手”）：输入框上方显示成引用块，
   * 发送时以 Markdown 引用（> ）放在消息开头。
   */
  quote: string | null
  setText: (u: Update<string>) => void
  setMentions: (u: Update<string[]>) => void
  setAttachments: (u: Update<Attachment[]>) => void
  suppress: (paths: string[]) => void
  setQuote: (quote: string | null) => void
  /** 发送成功后清空草稿；suppressed 保留 */
  clear: () => void
  resetSuppressed: () => void
}

export const useAgentDraft = create<DraftState>((set) => ({
  text: '',
  mentions: [],
  attachments: [],
  suppressed: [],
  quote: null,
  setText: (u) => set((s) => ({ text: apply(u, s.text) })),
  setMentions: (u) => set((s) => ({ mentions: apply(u, s.mentions) })),
  setAttachments: (u) => set((s) => ({ attachments: apply(u, s.attachments) })),
  suppress: (paths) => set((s) => ({ suppressed: [...new Set([...s.suppressed, ...paths])] })),
  setQuote: (quote) => set({ quote: quote?.trim() ? quote : null }),
  clear: () => set({ text: '', mentions: [], attachments: [], quote: null }),
  resetSuppressed: () => set((s) => (s.suppressed.length ? { suppressed: [] } : s)),
}))

/** 引用片段写成 Markdown 引用块（每行加 > ），去掉首尾空行。 */
export function quoteMarkdown(quote: string): string {
  return quote
    .replace(/^(\s*\n)+|(\n\s*)+$/g, '')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
}

/** 发送的正文：有引用时引用块在前，空一行后接用户的话。 */
export function withQuote(quote: string | null, text: string): string {
  if (!quote) return text
  const q = quoteMarkdown(quote)
  return text ? `${q}\n\n${text}` : q
}

/** 把消息开头的引用块拆出来，用于在消息气泡里单独显示。 */
export function splitQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && /^>( |$)/.test(lines[i])) i++
  if (i === 0) return { quote: null, body: text }
  const quote = lines
    .slice(0, i)
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n')
  return { quote, body: lines.slice(i).join('\n').replace(/^\n+/, '') }
}

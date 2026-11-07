import type { AgentEvent, ChatView, Chat, Draft, Message, Pending, ToolResult } from '../../api/agent'

/** 一个对话在前端的状态：已保存的消息、待批准操作，以及正在生成、尚未保存的草稿。 */
export interface ChatState {
  chat: Chat
  messages: Message[]
  pending: Pending[]
  running: boolean
  draft: Draft | null
  /** 最近一次生成失败的说明；下一次生成开始时清除 */
  error: string | null
}

export function fromView(v: ChatView): ChatState {
  return { chat: v.chat, messages: v.messages, pending: v.pending, running: v.running, draft: null, error: null }
}

const emptyDraft = (): Draft => ({ text: '', thinking: '', calls: [] })

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m]
  const next = list.slice()
  next[i] = m
  return next
}

/** 把服务端推送的一个事件合并进对话状态（见 agent.Event）。 */
export function applyEvent(s: ChatState, ev: AgentEvent): ChatState {
  switch (ev.type) {
    case 'state':
      if (!ev.running) return { ...s, running: false, draft: null }
      return { ...s, running: true, draft: ev.draft ? { ...ev.draft, calls: ev.draft.calls ?? [] } : (s.draft ?? emptyDraft()) }
    case 'text':
    case 'thinking': {
      const d = s.draft ?? emptyDraft()
      const draft = ev.type === 'text' ? { ...d, text: d.text + (ev.text ?? '') } : { ...d, thinking: d.thinking + (ev.text ?? '') }
      return { ...s, running: true, draft }
    }
    case 'tool_call': {
      if (!ev.call) return s
      const d = s.draft ?? emptyDraft()
      return { ...s, running: true, draft: { ...d, calls: [...(d.calls ?? []), ev.call] } }
    }
    case 'message': {
      const m = ev.message
      if (!m) return s
      const done = new Set(m.parts.flatMap((p) => (p.type === 'tool_result' && p.result ? [p.result.call_id] : [])))
      return {
        ...s,
        messages: upsert(s.messages, m),
        pending: done.size ? s.pending.filter((p) => !done.has(p.call_id)) : s.pending,
        draft: m.role === 'assistant' ? null : s.draft,
        // 用户发了新消息，开始新的生成
        error: m.role === 'user' && !done.size ? null : s.error,
      }
    }
    case 'approval': {
      const p = ev.pending
      if (!p || s.pending.some((x) => x.call_id === p.call_id)) return s
      return { ...s, pending: [...s.pending, p] }
    }
    case 'chat':
      return ev.chat ? { ...s, chat: ev.chat } : s
    case 'done':
      return { ...s, draft: null }
    case 'error':
      return { ...s, draft: null, error: ev.text ?? '生成失败' }
  }
  return s
}

/** 去掉只装工具结果的用户消息：结果显示在对应的工具卡片里。 */
export function visibleMessages(msgs: Message[]): Message[] {
  return msgs.filter((m) => m.role === 'assistant' || m.parts.some((p) => p.type !== 'tool_result'))
}

/** 工具调用 id → 结果。 */
export function resultsByCall(msgs: Message[]): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>()
  for (const m of msgs) for (const p of m.parts) if (p.type === 'tool_result' && p.result) out.set(p.result.call_id, p.result)
  return out
}

/** 用户消息里用户自己写的正文（不含 @ 附上的笔记内容）。 */
export function userText(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && !p.text?.startsWith('<note path='))
    .map((p) => p.text ?? '')
    .join('\n')
}

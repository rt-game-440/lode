import { describe, expect, it } from 'vitest'
import type { AgentEvent, Chat, Message } from '../../api/agent'
import { applyEvent, fromView, resultsByCall, userText, visibleMessages } from './chatState'

const chat: Chat = {
  id: 'c1',
  title: '',
  model_id: 'm1',
  effort: '',
  input_tokens: 0,
  output_tokens: 0,
  context_tokens: 0,
  created_at: 1,
  updated_at: 1,
}

const user: Message = { id: 1, role: 'user', parts: [{ type: 'text', text: '把周报改一下' }], meta: {}, created_at: 1 }
const assistant: Message = {
  id: 2,
  role: 'assistant',
  parts: [
    { type: 'text', text: '好的' },
    { type: 'tool_call', call: { id: 't1', name: 'update_note', args: { path: '周报.md' } } },
  ],
  meta: {},
  created_at: 2,
}
const result: Message = {
  id: 3,
  role: 'user',
  parts: [{ type: 'tool_result', result: { call_id: 't1', name: 'update_note', content: '已修改' } }],
  meta: {},
  created_at: 3,
}

function run(events: AgentEvent[]) {
  return events.reduce(applyEvent, fromView({ chat, messages: [], pending: [], running: false }))
}

describe('applyEvent', () => {
  it('流式增量累积成草稿，消息保存后清空草稿', () => {
    const s = run([
      { type: 'state', running: true, draft: { text: '', thinking: '', calls: null } },
      { type: 'message', message: user },
      { type: 'thinking', text: '想一' },
      { type: 'thinking', text: '想' },
      { type: 'text', text: '好' },
      { type: 'text', text: '的' },
    ])
    expect(s.running).toBe(true)
    expect(s.draft).toEqual({ text: '好的', thinking: '想一想', calls: [] })
    const after = applyEvent(s, { type: 'message', message: assistant })
    expect(after.draft).toBeNull()
    expect(after.messages.map((m) => m.id)).toEqual([1, 2])
  })

  it('重复收到同一条消息只保留一份（重连后重新拉取再补发）', () => {
    const s = run([{ type: 'message', message: user }, { type: 'message', message: user }])
    expect(s.messages).toHaveLength(1)
  })

  it('待批准的操作在收到对应的工具结果后移除', () => {
    const pending = { call_id: 't1', name: 'update_note', args: {}, preview: { action: 'update' as const, path: '周报.md' } }
    let s = run([{ type: 'approval', pending }, { type: 'approval', pending }])
    expect(s.pending).toHaveLength(1)
    s = applyEvent(s, { type: 'message', message: result })
    expect(s.pending).toHaveLength(0)
  })

  it('状态快照为空闲时结束生成并清空草稿', () => {
    const s = run([
      { type: 'text', text: '半句' },
      { type: 'state', running: false },
    ])
    expect(s.running).toBe(false)
    expect(s.draft).toBeNull()
  })

  it('出错时记下说明，下一次生成开始时清除', () => {
    let s = run([{ type: 'error', text: '鉴权失败', kind: 'auth' }])
    expect(s.error).toBe('鉴权失败')
    s = applyEvent(s, { type: 'message', message: user })
    expect(s.error).toBeNull()
  })

  it('chat 事件更新标题和用量', () => {
    const s = run([{ type: 'chat', chat: { ...chat, title: '周报', context_tokens: 1200 } }])
    expect(s.chat.title).toBe('周报')
    expect(s.chat.context_tokens).toBe(1200)
  })
})

describe('消息展示', () => {
  it('只含工具结果的用户消息不单独显示，结果按调用 id 归到工具卡片', () => {
    const msgs = [user, assistant, result]
    expect(visibleMessages(msgs).map((m) => m.id)).toEqual([1, 2])
    expect(resultsByCall(msgs).get('t1')?.content).toBe('已修改')
  })

  it('用户正文不含附上的笔记内容', () => {
    const m: Message = {
      ...user,
      parts: [
        { type: 'text', text: '总结一下' },
        { type: 'text', text: '<note path="a.md" rev="1">\n正文\n</note>' },
      ],
      meta: { mentions: ['a.md'] },
    }
    expect(userText(m)).toBe('总结一下')
  })
})

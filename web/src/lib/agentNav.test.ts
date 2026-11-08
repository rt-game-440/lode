import { describe, expect, it } from 'vitest'
import { agentBackAction, agentFrom, withAgentFrom, withoutAgentFrom } from './agentNav'

describe('助手页来源记录', () => {
  it('从笔记页进入：有来源，返回走历史', () => {
    const s = withAgentFrom(null, '/note/abc')
    expect(agentFrom(s)).toBe('/note/abc')
    expect(agentBackAction(s)).toBe('history')
  })
  it('保留历史项里已有的其他 state', () => {
    const s = withAgentFrom({ lodeFrom: '/settings' }, '/trash')
    expect(s).toEqual({ lodeFrom: '/settings', lodeAgentFrom: '/trash' })
  })
  it('直接打开或刷新：没有来源，返回回到列表', () => {
    expect(agentBackAction(null)).toBe('home')
    expect(agentBackAction({})).toBe('home')
    expect(agentBackAction(withoutAgentFrom(withAgentFrom(null, '/note/abc')))).toBe('home')
  })
  it('无效来源不算来源', () => {
    expect(agentBackAction({ lodeAgentFrom: 5 })).toBe('home')
    expect(agentBackAction({ lodeAgentFrom: '/agent' })).toBe('home')
    expect(agentBackAction({ lodeAgentFrom: 'http://evil' })).toBe('home')
  })
})

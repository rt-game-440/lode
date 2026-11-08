import { describe, expect, it, vi } from 'vitest'
import { parentTitle, prefixes, settingsPage, settingsPath, stackChange, backViaHistory } from './stack'

// stores/ui 在模块加载时读取 location 和 localStorage：先给 node 环境补上再导入
vi.stubGlobal('location', { pathname: '/' })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
const { parseRoute, routePath } = await import('../../stores/ui')

describe('设置子页面的地址', () => {
  it('每一级子页面都有自己的地址，解析和生成互逆', () => {
    for (const sub of [[], ['agent'], ['agent', 'p_1'], ['tokens', 'a b/c'], ['audit'], ['workspaces'], ['workspaces', 'k3f9a2']]) {
      const path = routePath({ view: 'settings', sub })
      expect(path).toBe(settingsPath(sub))
      const back = parseRoute(path)
      expect(back.view).toBe('settings')
      expect(back.view === 'settings' && (back.sub ?? [])).toEqual(sub)
    }
    expect(routePath({ view: 'settings' })).toBe('/settings')
    expect(parseRoute('/settings/')).toEqual({ view: 'settings' })
    expect(routePath({ view: 'settings', sub: ['tokens', 'a b/c'] })).toBe('/settings/tokens/a%20b%2Fc')
  })

  it('识别各级页面，未知路径返回 null', () => {
    expect(settingsPage([])).toEqual({ id: 'root' })
    expect(settingsPage(['appearance'])).toEqual({ id: 'appearance' })
    expect(settingsPage(['keyboard'])).toEqual({ id: 'keyboard' })
    expect(settingsPage(['passkeys'])).toEqual({ id: 'passkeys' })
    expect(settingsPage(['passkeys', 'x'])).toBeNull()
    expect(settingsPage(['agent'])).toEqual({ id: 'agent' })
    expect(settingsPage(['agent', 'p1'])).toEqual({ id: 'provider', param: 'p1' })
    expect(settingsPage(['mcp'])).toEqual({ id: 'mcp' })
    expect(settingsPage(['tokens'])).toEqual({ id: 'tokens' })
    expect(settingsPage(['tokens', 't1'])).toEqual({ id: 'token', param: 't1' })
    expect(settingsPage(['audit'])).toEqual({ id: 'audit' })
    expect(settingsPage(['workspaces'])).toEqual({ id: 'workspaces' })
    expect(settingsPage(['workspaces', 'k3f9a2'])).toEqual({ id: 'workspace', param: 'k3f9a2' })
    expect(settingsPage(['workspaces', 'k3f9a2', 'x'])).toBeNull()
    expect(settingsPage(['nope'])).toBeNull()
    expect(settingsPage(['mcp', 'x'])).toBeNull()
    expect(settingsPage(['agent', 'p1', 'x'])).toBeNull()
  })

  it('返回按钮上显示上一级的标题', () => {
    expect(parentTitle(['agent'])).toBe('设置')
    expect(parentTitle(['agent', 'p1'])).toBe('助手')
    expect(parentTitle(['tokens', 't1'])).toBe('API token')
    expect(parentTitle(['workspaces', 'k3f9a2'])).toBe('工作空间')
  })
})

describe('导航栈的变化方向', () => {
  it('更深一级是推入，回到祖先是推出，其余是直接替换', () => {
    expect(stackChange([], ['agent'])).toBe('push')
    expect(stackChange(['agent'], ['agent', 'p1'])).toBe('push')
    expect(stackChange([], ['tokens', 't1'])).toBe('push')
    expect(stackChange(['agent', 'p1'], ['agent'])).toBe('pop')
    expect(stackChange(['tokens', 't1'], [])).toBe('pop')
    expect(stackChange(['tokens'], ['agent'])).toBe('replace')
    expect(stackChange(['agent', 'p1'], ['agent', 'p2'])).toBe('replace')
    expect(stackChange(['agent'], ['agent'])).toBe('none')
  })

  it('栈里的每一层是当前路径的各级前缀', () => {
    expect(prefixes([])).toEqual([[]])
    expect(prefixes(['agent', 'p1'])).toEqual([[], ['agent'], ['agent', 'p1']])
  })

  it('上一条历史就是上一级时用浏览器后退，否则替换成上一级', () => {
    expect(backViaHistory({ lodeFrom: '/settings' }, ['agent'])).toBe(true)
    expect(backViaHistory({ lodeFrom: '/settings/agent' }, ['agent', 'p1'])).toBe(true)
    expect(backViaHistory({ lodeFrom: '/settings' }, ['agent', 'p1'])).toBe(false)
    expect(backViaHistory(null, ['agent'])).toBe(false)
    expect(backViaHistory({ lodeFrom: '/settings/tokens/a%20b' }, ['tokens', 'a b', 'x'])).toBe(true)
  })
})

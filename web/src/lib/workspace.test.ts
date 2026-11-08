import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_STORAGE,
  apiPrefix,
  currentWorkspace,
  localDbName,
  routePrefix,
  setCurrentWorkspace,
  splitWorkspacePath,
  storageKey,
  workspaceOfApiUrl,
  workspacePath,
} from './workspace'

// stores/ui、stores/agent 在模块加载时读取 location 和 localStorage：先给 node 环境补上再导入
const store = new Map<string, string>()
vi.stubGlobal('location', { pathname: '/', origin: 'http://127.0.0.1:8787' })
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
})
const { api, fileUrl, workspaceApi } = await import('../api/client')
const { agentApi } = await import('../api/agent')
const { recentIds } = await import('../features/actions')
const { useAgent } = await import('../stores/agent')

const WS = 'k3f9a2'

afterEach(() => {
  setCurrentWorkspace(DEFAULT_WORKSPACE)
  store.clear()
  vi.unstubAllGlobals()
  vi.stubGlobal('location', { pathname: '/', origin: 'http://127.0.0.1:8787' })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('API 前缀', () => {
  it('默认工作空间是 /api，其他是 /api/w/<id>', () => {
    expect(apiPrefix(DEFAULT_WORKSPACE)).toBe('/api')
    expect(apiPrefix(WS)).toBe(`/api/w/${WS}`)
  })

  it('能从 API 地址认出工作空间，全局接口和默认工作空间返回 null', () => {
    expect(workspaceOfApiUrl(`/api/w/${WS}/notes/x`)).toBe(WS)
    expect(workspaceOfApiUrl(`/api/w/${WS}?a=1`)).toBe(WS)
    expect(workspaceOfApiUrl('/api/notes/x')).toBeNull()
    expect(workspaceOfApiUrl('/api/workspaces')).toBeNull()
  })

  describe('客户端', () => {
    let urls: string[]
    beforeEach(() => {
      urls = []
      vi.stubGlobal('fetch', async (url: string) => {
        urls.push(url)
        return new Response('{"folders":[],"notes":[],"seq":0,"chats":[],"workspaces":[]}', { status: 200 })
      })
    })

    it('笔记相关接口跟随当前工作空间，全局接口不加前缀', async () => {
      await api.tree()
      await api.search('a b')
      await api.authStatus()
      await api.workspaces()
      setCurrentWorkspace(WS)
      await api.tree()
      await api.readNote('n 1')
      await api.search('a b')
      await api.changes(5)
      await api.authStatus()
      await api.tokens()
      await api.workspaces()
      expect(urls).toEqual([
        '/api/tree',
        '/api/search?q=a+b&limit=30',
        '/api/auth/status',
        '/api/workspaces',
        `/api/w/${WS}/tree`,
        `/api/w/${WS}/notes/n%201`,
        `/api/w/${WS}/search?q=a+b&limit=30`,
        `/api/w/${WS}/changes?since=5`,
        '/api/auth/status',
        '/api/tokens',
        '/api/workspaces',
      ])
    })

    it('workspaceApi 固定在创建时的工作空间上，不随当前工作空间变化', async () => {
      const fixed = workspaceApi(WS)
      const def = workspaceApi(DEFAULT_WORKSPACE)
      await fixed.updateNote('n', 1, 'x')
      await def.tree()
      setCurrentWorkspace('other1')
      await fixed.tree()
      await def.changes(0)
      expect(urls).toEqual([`/api/w/${WS}/notes/n`, '/api/tree', `/api/w/${WS}/tree`, '/api/changes?since=0'])
    })

    it('文件地址和助手对话按工作空间，助手供应商和设置是全局的', async () => {
      expect(fileUrl('附件/a b.png')).toBe('/api/files/%E9%99%84%E4%BB%B6/a%20b.png')
      expect(agentApi.streamUrl('c1')).toBe('/api/agent/chats/c1/stream')
      setCurrentWorkspace(WS)
      expect(fileUrl('a.png')).toBe(`/api/w/${WS}/files/a.png`)
      expect(agentApi.streamUrl('c1')).toBe(`/api/w/${WS}/agent/chats/c1/stream`)
      await agentApi.chats().catch(() => {})
      await agentApi.config().catch(() => {})
      expect(urls).toEqual([`/api/w/${WS}/agent/chats`, '/api/agent/config'])
    })
  })
})

describe('页面路径', () => {
  it('默认工作空间不加前缀，保持原有地址', () => {
    expect(routePrefix(DEFAULT_WORKSPACE)).toBe('')
    for (const p of ['/', '/note/abc', '/settings/tokens', '/tag/a/b', '/trash', '/agent']) {
      expect(workspacePath(DEFAULT_WORKSPACE, p)).toBe(p)
      expect(splitWorkspacePath(p)).toEqual({ ws: DEFAULT_WORKSPACE, rest: p })
    }
  })

  it('其他工作空间用 /w/<id>/...，首页是 /w/<id>，解析和生成互逆', () => {
    expect(workspacePath(WS, '/')).toBe(`/w/${WS}`)
    expect(workspacePath(WS, '/note/abc')).toBe(`/w/${WS}/note/abc`)
    for (const p of ['/', '/note/abc', '/settings/agent/p_1', '/trash']) {
      expect(splitWorkspacePath(workspacePath(WS, p))).toEqual({ ws: WS, rest: p })
    }
    expect(splitWorkspacePath(`/w/${WS}/`)).toEqual({ ws: WS, rest: '/' })
  })

  it('/w 本身和 /wiki 之类不是工作空间前缀', () => {
    expect(splitWorkspacePath('/w')).toEqual({ ws: DEFAULT_WORKSPACE, rest: '/w' })
    expect(splitWorkspacePath('/wiki/x')).toEqual({ ws: DEFAULT_WORKSPACE, rest: '/wiki/x' })
  })
})

describe('本机存储按工作空间区分', () => {
  it('localStorage 键名：默认工作空间沿用原键名，其他加 :<id>', () => {
    expect(WORKSPACE_STORAGE).toEqual({ recent: 'lode.recent', expanded: 'lode.expanded', agentChat: 'lode.agent.chat' })
    expect(storageKey(WORKSPACE_STORAGE.recent, DEFAULT_WORKSPACE)).toBe('lode.recent')
    expect(storageKey(WORKSPACE_STORAGE.expanded, DEFAULT_WORKSPACE)).toBe('lode.expanded')
    expect(storageKey(WORKSPACE_STORAGE.agentChat, DEFAULT_WORKSPACE)).toBe('lode.agent.chat')
    expect(storageKey(WORKSPACE_STORAGE.recent, WS)).toBe(`lode.recent:${WS}`)
    expect(storageKey(WORKSPACE_STORAGE.expanded, WS)).toBe(`lode.expanded:${WS}`)
    expect(storageKey(WORKSPACE_STORAGE.agentChat, WS)).toBe(`lode.agent.chat:${WS}`)
  })

  it('IndexedDB 名称：默认工作空间沿用 lode，其他是 lode:<id>', () => {
    expect(localDbName(DEFAULT_WORKSPACE)).toBe('lode')
    expect(localDbName(WS)).toBe(`lode:${WS}`)
  })

  it('最近打开读当前工作空间的键', () => {
    store.set('lode.recent', JSON.stringify(['d1', 'd2']))
    store.set(`lode.recent:${WS}`, JSON.stringify(['w1']))
    expect(recentIds()).toEqual(['d1', 'd2'])
    setCurrentWorkspace(WS)
    expect(currentWorkspace()).toBe(WS)
    expect(recentIds()).toEqual(['w1'])
  })

  it('当前助手对话按工作空间记住，切换后换成新工作空间记住的那个', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    store.set('lode.agent.chat', 'chat-default')
    store.set(`lode.agent.chat:${WS}`, 'chat-ws')
    setCurrentWorkspace(WS)
    useAgent.getState().switchWorkspace()
    expect(useAgent.getState().activeId).toBe('chat-ws')
    expect(useAgent.getState().chats).toBeNull()
    setCurrentWorkspace(DEFAULT_WORKSPACE)
    useAgent.getState().switchWorkspace()
    expect(useAgent.getState().activeId).toBe('chat-default')
    // 新对话（open(null)）只清掉当前工作空间记住的对话
    await useAgent.getState().open(null)
    expect(store.has('lode.agent.chat')).toBe(false)
    expect(store.get(`lode.agent.chat:${WS}`)).toBe('chat-ws')
  })
})

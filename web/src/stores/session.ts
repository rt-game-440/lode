import { create } from 'zustand'
import { ApiError, api, setUnauthorizedHandler } from '../api/client'
import { sync } from '../sync/engine'

type Phase = 'loading' | 'setup' | 'login' | 'ready' | 'offline'

interface SessionState {
  phase: Phase
  check: () => Promise<void>
  setup: (password: string) => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  phase: 'loading',
  check: async () => {
    try {
      const s = await api.authStatus()
      set({ phase: !s.initialized ? 'setup' : s.authenticated ? 'ready' : 'login' })
    } catch (err) {
      // 断网冷启动：有缓存的笔记树就直接进入应用，离线编辑，联网后同步
      const cached = err instanceof ApiError && err.code === 'network' && (await sync.db.getTree().catch(() => undefined))
      set({ phase: cached ? 'ready' : 'offline' })
    }
  },
  setup: async (password) => {
    await api.setup(password)
    set({ phase: 'ready' })
  },
  login: async (password) => {
    await api.login(password)
    set({ phase: 'ready' })
  },
  logout: async () => {
    await api.logout().catch(() => {})
    await sync.db.clearCache().catch(() => {})
    set({ phase: 'login' })
  },
}))

setUnauthorizedHandler(() => {
  if (useSession.getState().phase === 'ready') useSession.setState({ phase: 'login' })
})

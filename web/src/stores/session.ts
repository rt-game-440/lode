import { create } from 'zustand'
import { api, setUnauthorizedHandler } from '../api/client'

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
    } catch {
      set({ phase: 'offline' })
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
    set({ phase: 'login' })
  },
}))

setUnauthorizedHandler(() => {
  if (useSession.getState().phase === 'ready') useSession.setState({ phase: 'login' })
})

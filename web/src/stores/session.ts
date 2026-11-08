import { create } from 'zustand'
import { ApiError, api, setUnauthorizedHandler } from '../api/client'
import { getPasskey } from '../lib/webauthn'
import { sync } from '../sync/engine'
import { clearAllLocalCaches } from './workspace'

type Phase = 'loading' | 'setup' | 'login' | 'ready' | 'offline'

interface SessionState {
  phase: Phase
  /** 当前域名下登记过通行密钥（登录页据此显示通行密钥按钮） */
  passkey: boolean
  check: () => Promise<void>
  setup: (password: string) => Promise<void>
  login: (password: string) => Promise<void>
  loginWithPasskey: () => Promise<void>
  /** 重新读取服务端的通行密钥状态（登录页挂载时调用，登记/删除后可能变了） */
  refreshPasskey: () => Promise<void>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  phase: 'loading',
  passkey: false,
  check: async () => {
    try {
      const s = await api.authStatus()
      set({ phase: !s.initialized ? 'setup' : s.authenticated ? 'ready' : 'login', passkey: Boolean(s.passkey) })
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
  loginWithPasskey: async () => {
    const { ceremony, options } = await api.passkeyLoginBegin()
    const credential = await getPasskey(options)
    await api.passkeyLoginFinish(ceremony, credential)
    set({ phase: 'ready' })
  },
  refreshPasskey: async () => {
    const s = await api.authStatus().catch(() => null)
    if (s) set({ passkey: Boolean(s.passkey) })
  },
  logout: async () => {
    await api.logout().catch(() => {})
    await clearAllLocalCaches().catch(() => {})
    set({ phase: 'login' })
  },
}))

setUnauthorizedHandler(() => {
  if (useSession.getState().phase === 'ready') useSession.setState({ phase: 'login' })
})

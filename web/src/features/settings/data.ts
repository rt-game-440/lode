import { create } from 'zustand'
import { api } from '../../api/client'
import type { ApiToken, AuditEntry, Passkey } from '../../api/types'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../actions'

/**
 * 设置各级页面共用的数据：首页的状态摘要、token 列表和单个 token 页、调用记录页读同一份。
 * 离开设置后保留，再进来先显示缓存再刷新。
 */
interface SettingsData {
  tokens: ApiToken[] | null
  passkeys: Passkey[] | null
  audit: AuditEntry[] | null
  auditLoading: boolean
  loadTokens: () => Promise<void>
  loadPasskeys: () => Promise<void>
  addPasskey: (p: Passkey) => void
  removePasskey: (id: string) => void
  loadAudit: () => Promise<void>
  addToken: (t: ApiToken) => void
  removeToken: (id: string) => void
}

function toastError(err: unknown) {
  useUI.getState().toast({ message: errorMessage(err), tone: 'error' })
}

export const useSettingsData = create<SettingsData>((set) => ({
  tokens: null,
  passkeys: null,
  audit: null,
  auditLoading: false,
  loadTokens: async () => {
    try {
      set({ tokens: await api.tokens() })
    } catch (err) {
      toastError(err)
      set((s) => ({ tokens: s.tokens ?? [] }))
    }
  },
  loadPasskeys: async () => {
    try {
      set({ passkeys: await api.passkeys() })
    } catch (err) {
      toastError(err)
      set((s) => ({ passkeys: s.passkeys ?? [] }))
    }
  },
  addPasskey: (p) => set((s) => ({ passkeys: [...(s.passkeys ?? []), p] })),
  removePasskey: (id) => set((s) => ({ passkeys: s.passkeys?.filter((x) => x.id !== id) ?? null })),
  loadAudit: async () => {
    set({ auditLoading: true })
    try {
      set({ audit: await api.audit(100) })
    } catch (err) {
      toastError(err)
      set((s) => ({ audit: s.audit ?? [] }))
    } finally {
      set({ auditLoading: false })
    }
  },
  addToken: (t) => set((s) => ({ tokens: [t, ...(s.tokens ?? [])] })),
  removeToken: (id) => set((s) => ({ tokens: s.tokens?.filter((x) => x.id !== id) ?? null })),
}))

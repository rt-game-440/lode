import { create } from 'zustand'
import {
  type AgentConfig,
  type AgentEvent,
  type AgentModel,
  type Attachment,
  type Chat,
  type Effort,
  type Provider,
  agentApi,
} from '../api/agent'
import { ApiError, errorMessage } from '../api/client'
import { type ChatState, applyEvent, fromView } from '../features/agent/chatState'
import { useUI } from './ui'

const ACTIVE_KEY = 'lode.agent.chat'

export interface ModelOption extends AgentModel {
  provider: Provider
}

/** 全部已启用的模型，按供应商分组的顺序。 */
export function enabledModels(cfg: AgentConfig | null): ModelOption[] {
  if (!cfg) return []
  return cfg.providers.flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ ...m, provider: p })))
}

/** 对话实际使用的模型：对话指定的，否则是默认模型。 */
export function chatModel(cfg: AgentConfig | null, chat: Chat | null | undefined): ModelOption | null {
  const all = cfg ? cfg.providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p }))) : []
  const id = chat?.model_id || cfg?.settings.default_model
  return all.find((m) => m.id === id) ?? null
}

interface AgentState {
  config: AgentConfig | null
  loadConfig: () => Promise<void>

  chats: Chat[] | null
  loadChats: () => Promise<void>

  /** 当前打开的对话 */
  activeId: string | null
  current: ChatState | null
  open: (id: string | null) => Promise<void>
  /** 回到空白的新对话 */
  newChat: () => Promise<void>
  removeChat: (id: string) => Promise<void>

  send: (text: string, mentions: string[], attachments: Attachment[]) => Promise<boolean>
  stop: () => Promise<void>
  resolve: (callId: string, approve: boolean) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (effort: Effort | '') => Promise<void>

  /** 打开助手面板的组件数；为 0 时断开事件流 */
  attach: () => () => void
}

function toastError(err: unknown) {
  useUI.getState().toast({ message: errorMessage(err), tone: 'error' })
}

export const useAgent = create<AgentState>((set, get) => {
  let source: EventSource | null = null
  let sourceId: string | null = null
  let attached = 0
  /** 等待合并的事件：一帧合并一次，流式增量再快也只渲染一次 */
  let queue: AgentEvent[] = []
  let frame = 0
  /** 重新拉取对话期间先缓存事件，拉取完成后按顺序补上 */
  let syncing: AgentEvent[] | null = null

  const flush = () => {
    frame = 0
    const cur = get().current
    const evs = queue
    queue = []
    if (!cur || !evs.length) return
    const next = evs.reduce(applyEvent, cur)
    set({ current: next })
    // 标题和用量变化同步到会话列表
    const chats = get().chats
    if (chats && next.chat !== cur.chat) {
      const rest = chats.filter((c) => c.id !== next.chat.id)
      set({ chats: [next.chat, ...rest] })
    }
  }

  const push = (ev: AgentEvent) => {
    if (syncing) {
      syncing.push(ev)
      return
    }
    queue.push(ev)
    if (!frame) frame = requestAnimationFrame(flush)
  }

  /** 每次（重新）连接后先拉取完整对话，避免断线期间漏掉的消息。 */
  const resync = async (id: string, snapshot: AgentEvent) => {
    syncing = [snapshot]
    try {
      const view = await agentApi.chat(id)
      if (get().activeId !== id) return
      const evs = syncing
      syncing = null
      queue = []
      set({ current: evs.reduce(applyEvent, fromView(view)) })
    } catch (err) {
      syncing = null
      if (get().activeId === id) toastError(err)
    }
  }

  const disconnect = () => {
    source?.close()
    source = null
    sourceId = null
    syncing = null
    queue = []
  }

  const connect = (id: string) => {
    if (sourceId === id && source) return
    disconnect()
    sourceId = id
    const es = new EventSource(agentApi.streamUrl(id))
    source = es
    let fresh = true
    es.onmessage = (m) => {
      if (source !== es) return
      let ev: AgentEvent
      try {
        ev = JSON.parse(m.data)
      } catch {
        return
      }
      if (fresh && ev.type === 'state') {
        fresh = false
        void resync(id, ev)
        return
      }
      push(ev)
    }
    // EventSource 会自动重连；重连后的第一条状态快照触发重新拉取
    es.onerror = () => {
      fresh = true
    }
  }

  const ensureConnected = () => {
    const id = get().activeId
    if (attached > 0 && id) connect(id)
    else disconnect()
  }

  const createAndOpen = async (modelId: string) => {
    const c = await agentApi.createChat(modelId)
    set({ chats: [c, ...(get().chats ?? [])] })
    await get().open(c.id)
    return c.id
  }

  const patchChat = (c: Chat) => {
    const cur = get().current
    if (cur && cur.chat.id === c.id) set({ current: { ...cur, chat: c } })
    set({ chats: (get().chats ?? []).map((x) => (x.id === c.id ? c : x)) })
  }

  return {
    config: null,
    loadConfig: async () => {
      try {
        set({ config: await agentApi.config() })
      } catch (err) {
        toastError(err)
      }
    },

    chats: null,
    loadChats: async () => {
      try {
        set({ chats: await agentApi.chats() })
      } catch (err) {
        toastError(err)
        set({ chats: [] })
      }
    },

    activeId: localStorage.getItem(ACTIVE_KEY),
    current: null,
    open: async (id) => {
      if (id) localStorage.setItem(ACTIVE_KEY, id)
      else localStorage.removeItem(ACTIVE_KEY)
      set({ activeId: id, current: get().current?.chat.id === id ? get().current : null })
      disconnect()
      if (!id) return
      try {
        const view = await agentApi.chat(id)
        if (get().activeId !== id) return
        set({ current: fromView(view) })
        ensureConnected()
      } catch (err) {
        if (get().activeId !== id) return
        // 对话已在别处删除：回到空白状态
        localStorage.removeItem(ACTIVE_KEY)
        set({ activeId: null, current: null })
        if (!(err instanceof ApiError && err.status === 404)) toastError(err)
      }
    },
    // 新对话先只是空白状态，发第一条消息（或换模型）时才在服务端创建
    newChat: async () => {
      await get().open(null)
    },
    removeChat: async (id) => {
      try {
        await agentApi.deleteChat(id)
        set({ chats: (get().chats ?? []).filter((c) => c.id !== id) })
        if (get().activeId === id) await get().open(null)
      } catch (err) {
        toastError(err)
      }
    },

    send: async (text, mentions, attachments) => {
      try {
        const id = get().activeId ?? (await createAndOpen(''))
        await agentApi.send(id, { text, mentions, attachments })
        return true
      } catch (err) {
        toastError(err)
        return false
      }
    },
    stop: async () => {
      const id = get().activeId
      if (!id) return
      try {
        await agentApi.stop(id)
      } catch (err) {
        toastError(err)
      }
    },
    resolve: async (callId, approve) => {
      const id = get().activeId
      if (!id) return
      try {
        await agentApi.resolve(id, callId, approve)
        const cur = get().current
        if (cur) set({ current: { ...cur, pending: cur.pending.filter((p) => p.call_id !== callId) } })
      } catch (err) {
        toastError(err)
      }
    },
    setModel: async (modelId) => {
      try {
        const id = get().activeId
        if (id) patchChat(await agentApi.updateChat(id, { model_id: modelId }))
        else await createAndOpen(modelId)
      } catch (err) {
        toastError(err)
      }
    },
    setEffort: async (effort) => {
      try {
        const id = get().activeId ?? (await createAndOpen(''))
        patchChat(await agentApi.updateChat(id, { effort }))
      } catch (err) {
        toastError(err)
      }
    },

    attach: () => {
      attached++
      ensureConnected()
      return () => {
        attached--
        // 下一帧再判断：切换布局时新面板先挂载、旧面板后卸载
        setTimeout(ensureConnected, 0)
      }
    },
  }
})


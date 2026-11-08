// 助手接口（docs/api.md 的“助手”一节）。字段与服务端一致，用 snake_case。
import { apiPrefix, currentWorkspace } from '../lib/workspace'
import { request } from './client'

export type ProviderKind = 'openai' | 'anthropic' | 'gemini'
export type Effort = 'off' | 'low' | 'medium' | 'high'
export type Modality = 'text' | 'image' | 'pdf' | 'audio'

export const EFFORT_LABEL: Record<Effort, string> = { off: '关闭', low: '低', medium: '中', high: '高' }
export const KIND_LABEL: Record<ProviderKind, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' }

export interface AgentModel {
  id: string
  provider_id: string
  model: string
  name: string
  enabled: boolean
  context_window: number
  max_output: number
  reasoning: boolean
  effort: Effort
  modalities: Modality[]
  tools: boolean
  temperature: number | null
}

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  base_url: string
  has_key: boolean
  key_last4: string
  created_at: number
  models: AgentModel[]
}

export interface AgentSettings {
  default_model: string
  auto_approve: boolean
}

export interface AgentConfig {
  secret_key_set: boolean
  /** API key 由通行密钥保护且服务重启后还没解锁（#29）：助手暂时用不了已保存的 key */
  keys_locked?: boolean
  settings: AgentSettings
  providers: Provider[]
}

export interface ProviderInput {
  name: string
  kind: ProviderKind
  base_url: string
  /** 省略表示不修改，空字符串表示清除 */
  api_key?: string
}

export interface ModelInput {
  model: string
  name: string
  enabled: boolean
  context_window: number
  max_output: number
  reasoning: boolean
  effort: Effort
  modalities: Modality[]
  tools: boolean
  temperature: number | null
}

export interface ModelInfo {
  id: string
  name?: string
  context_window?: number
  max_output?: number
}

export interface TestResult {
  ok: boolean
  kind?: string
  message: string
  models: ModelInfo[]
}

export interface Chat {
  id: string
  title: string
  model_id: string
  /** 本会话覆盖的推理强度；空字符串表示用模型的设置 */
  effort: Effort | ''
  input_tokens: number
  output_tokens: number
  /** 最近一次请求的输入 token，即当前占用的上下文 */
  context_tokens: number
  created_at: number
  updated_at: number
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolResult {
  call_id: string
  name: string
  content: string
  is_error?: boolean
}

export interface Part {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'media'
  text?: string
  call?: ToolCall
  result?: ToolResult
  media?: { mime: string; name?: string }
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  parts: Part[]
  meta: { mentions?: string[]; stopped?: boolean; error?: string }
  model?: string
  usage?: { input: number; output: number; reasoning?: number }
  created_at: number
}

export interface DiffLine {
  /** ' ' 不变，'-' 删除，'+' 新增，'…' 省略了 text 行不变的内容 */
  op: ' ' | '-' | '+' | '…'
  text: string
}

export interface Pending {
  call_id: string
  name: string
  args: unknown
  preview: { action: 'create' | 'update' | 'move' | 'delete'; path: string; to?: string; diff?: DiffLine[]; error?: string }
}

export interface Draft {
  text: string
  thinking: string
  calls: ToolCall[] | null
}

export interface ChatView {
  chat: Chat
  messages: Message[]
  pending: Pending[]
  running: boolean
}

export type DoneReason = 'stop' | 'tool_calls' | 'max_tokens' | 'refusal' | 'stopped' | 'awaiting_approval'

export interface AgentEvent {
  type: 'state' | 'text' | 'thinking' | 'tool_call' | 'message' | 'approval' | 'chat' | 'done' | 'error'
  text?: string
  call?: ToolCall
  message?: Message
  pending?: Pending
  chat?: Chat
  running?: boolean
  draft?: Draft
  stop?: DoneReason
  kind?: string
}

export interface Attachment {
  name: string
  mime: string
  /** base64 */
  data: string
}

const enc = encodeURIComponent
/** 对话按工作空间区分（`/api/agent/chats` 或 `/api/w/<id>/agent/chats`）；供应商、模型和设置是全局的。 */
const chatsBase = () => `${apiPrefix(currentWorkspace())}/agent/chats`

export const agentApi = {
  config: () => request<AgentConfig>('GET', '/api/agent/config'),
  createProvider: (p: ProviderInput) => request<Provider>('POST', '/api/agent/providers', p),
  updateProvider: (id: string, p: ProviderInput) => request<Provider>('PUT', `/api/agent/providers/${enc(id)}`, p),
  deleteProvider: (id: string) => request<void>('DELETE', `/api/agent/providers/${enc(id)}`),
  testProvider: (id: string) => request<TestResult>('POST', `/api/agent/providers/${enc(id)}/test`),
  createModel: (providerId: string, m: ModelInput) => request<AgentModel>('POST', `/api/agent/providers/${enc(providerId)}/models`, m),
  updateModel: (id: string, m: ModelInput) => request<AgentModel>('PUT', `/api/agent/models/${enc(id)}`, m),
  deleteModel: (id: string) => request<void>('DELETE', `/api/agent/models/${enc(id)}`),
  updateSettings: (s: AgentSettings) => request<AgentSettings>('PUT', '/api/agent/settings', s),

  chats: () => request<{ chats: Chat[] }>('GET', chatsBase()).then((r) => r.chats),
  createChat: (modelId = '') => request<Chat>('POST', chatsBase(), { model_id: modelId }),
  chat: (id: string) => request<ChatView>('GET', `${chatsBase()}/${enc(id)}`),
  updateChat: (id: string, patch: { title?: string; model_id?: string; effort?: Effort | '' }) =>
    request<Chat>('PATCH', `${chatsBase()}/${enc(id)}`, patch),
  deleteChat: (id: string) => request<void>('DELETE', `${chatsBase()}/${enc(id)}`),
  send: (id: string, input: { text: string; mentions: string[]; attachments: Attachment[] }) =>
    request<{ message: Message }>('POST', `${chatsBase()}/${enc(id)}/messages`, input).then((r) => r.message),
  stop: (id: string) => request<void>('POST', `${chatsBase()}/${enc(id)}/stop`),
  resolve: (id: string, callId: string, approve: boolean) =>
    request<void>('POST', `${chatsBase()}/${enc(id)}/approvals/${enc(callId)}`, { approve }),
  streamUrl: (id: string) => `${chatsBase()}/${enc(id)}/stream`,
}

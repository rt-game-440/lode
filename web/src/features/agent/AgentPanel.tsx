import { AlertCircle, ChevronLeft, History, Maximize2, MessageSquarePlus, Settings, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { confirmDialog } from '../../components/overlays'
import { Button, EmptyState, IconButton, Spinner } from '../../components/ui'
import { chatModel, enabledModels, useAgent } from '../../stores/agent'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { PanelToggleSlot } from '../shell/PanelToggle'
import { Composer } from './Composer'
import { ApprovalCard, DraftView, MessageView } from './Thread'
import { resultsByCall, visibleMessages } from './chatState'
import './agent.css'

const dateFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 1234 → 1.2k，1234567 → 1.2M */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function ChatList({ onPicked }: { onPicked: () => void }) {
  const chats = useAgent((s) => s.chats)
  const activeId = useAgent((s) => s.activeId)
  const open = useAgent((s) => s.open)
  const removeChat = useAgent((s) => s.removeChat)
  const remove = async (id: string, title: string) => {
    const ok = await confirmDialog({
      title: `删除对话“${title || '新对话'}”？`,
      message: '对话记录会被永久删除，无法恢复。助手已经做出的笔记修改不受影响。',
      confirmLabel: '删除',
      danger: true,
    })
    if (ok) await removeChat(id)
  }
  if (!chats) return <div className="agent-center"><Spinner /></div>
  if (!chats.length) return <EmptyState title="还没有对话" />
  return (
    <ul className="chat-list" aria-label="对话列表">
      {chats.map((c) => (
        <li key={c.id} className={`chat-item${c.id === activeId ? ' is-active' : ''}`}>
          <button
            type="button"
            className="chat-open"
            aria-current={c.id === activeId ? 'true' : undefined}
            onClick={() => {
              void open(c.id)
              onPicked()
            }}
          >
            <span className="chat-title">{c.title || '新对话'}</span>
            <span className="chat-meta">{dateFmt.format(c.updated_at)}</span>
          </button>
          <IconButton label={`删除对话“${c.title || '新对话'}”`} size="sm" onClick={() => void remove(c.id, c.title)}>
            <Trash2 size={14} />
          </IconButton>
        </li>
      ))}
    </ul>
  )
}

/** 自动滚到底部：只有用户本来就在底部附近时才跟随新内容。 */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return { ref, stick }
}

function Thread() {
  const current = useAgent((s) => s.current)
  const activeId = useAgent((s) => s.activeId)
  const msgs = useMemo(() => (current ? visibleMessages(current.messages) : []), [current?.messages])
  const results = useMemo(() => (current ? resultsByCall(current.messages) : new Map()), [current?.messages])
  const { ref, stick } = useStickToBottom(current)
  // 切换对话时回到底部
  useLayoutEffect(() => {
    stick.current = true
  }, [activeId, stick])

  const last = current?.messages[current.messages.length - 1]
  const showError = current?.error && !(last?.role === 'assistant' && last.meta.error)

  return (
    <div className="agent-thread" ref={ref} data-testid="agent-thread">
      {activeId && !current ? (
        <div className="agent-center">
          <Spinner />
        </div>
      ) : !msgs.length && !current?.draft ? (
        <EmptyState icon={<Sparkles size={28} strokeWidth={1.5} />} title="问问助手">
          它可以搜索、阅读和整理你的笔记。修改笔记之前，会先把改动给你看，等你批准。
        </EmptyState>
      ) : (
        <>
          {msgs.map((m) => (
            <MessageView key={m.id} m={m} results={results} running={current?.running ?? false} />
          ))}
          {current?.draft && <DraftView draft={current.draft} />}
          {current?.running && !current.draft && (
            <div className="msg msg-assistant">
              <span className="typing" aria-label="正在回复">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
          {current?.pending.map((p) => <ApprovalCard key={p.call_id} p={p} />)}
          {showError && (
            <p className="msg-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              {current.error}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function NoModels({ secretKeySet }: { secretKeySet: boolean }) {
  const navigate = useUI((s) => s.navigate)
  return (
    <div className="agent-center">
      <EmptyState icon={<Sparkles size={28} strokeWidth={1.5} />} title="还没有可用的模型">
        {secretKeySet
          ? '在设置的“助手”里添加一个模型供应商（OpenAI 兼容、Anthropic 或 Gemini）和模型。'
          : '服务器暂时没有可用的主密钥，不能保存 API key。请检查数据目录是否可写后重启 Lode。'}
        <div className="agent-empty-action">
          <Button size="sm" variant="primary" icon={<Settings size={14} />} onClick={() => navigate({ view: 'settings', sub: ['agent'] })}>
            打开设置
          </Button>
        </div>
      </EmptyState>
    </div>
  )
}

/** 弹窗里的助手：标题栏多出“展开”和“关闭”两个按钮 */
export interface AgentPopupActions {
  /** 展开到助手页面，接着同一个会话继续 */
  onExpand: () => void
  onClose: () => void
}

/**
 * 助手：会话列表、消息流和输入框。笔记页上在弹窗里打开（popup），侧栏底部的全局入口是整页（page）。
 * contextNoteId 是“当前笔记”，默认作为 @ 附上。
 * popup 在手机上是底部面板：标题栏同时是面板的拖动区域（data-sheet-drag）。
 */
export function AgentPanel({
  contextNoteId,
  mobile,
  page,
  popup,
  focusInput,
}: {
  contextNoteId: string | null
  mobile: boolean
  page?: boolean
  popup?: AgentPopupActions
  /** 打开后把焦点放进输入框（桌面弹窗；手机上会弹出软键盘，不用） */
  focusInput?: boolean
}) {
  const config = useAgent((s) => s.config)
  const current = useAgent((s) => s.current)
  const activeId = useAgent((s) => s.activeId)
  const attach = useAgent((s) => s.attach)
  const newChat = useAgent((s) => s.newChat)
  const navigate = useUI((s) => s.navigate)
  const contextPath = useVault((s) => (contextNoteId ? (s.notes[contextNoteId]?.path ?? null) : null))
  const [listOpen, setListOpen] = useState(false)

  useEffect(() => attach(), [attach])
  useEffect(() => {
    const st = useAgent.getState()
    void st.loadConfig()
    void st.loadChats()
    if (st.activeId && !st.current) void st.open(st.activeId)
  }, [])

  const model = chatModel(config, current?.chat)
  const ready = config !== null
  const noModels = ready && enabledModels(config).length === 0
  const chat = current?.chat
  const title = listOpen ? '对话' : chat?.title || '新对话'

  return (
    <section className={`agent${page ? ' is-page' : ''}${popup ? ' is-popup' : ''}`} aria-label="助手" data-testid="agent-panel">
      <header className="agent-head" data-sheet-drag={popup && mobile ? '' : undefined}>
        {page && mobile && (
          <IconButton label="返回" onClick={() => navigate({ view: 'home' })}>
            <ChevronLeft size={22} />
          </IconButton>
        )}
        {/* 桌面端助手页面：侧栏收起后展开按钮停在左上角，给它让位（见 shell/PanelToggle） */}
        {page && !mobile && <PanelToggleSlot side="left" />}
        <h2 className="agent-title" title={title}>
          {title}
        </h2>
        {!listOpen && chat && model && chat.context_tokens > 0 && (
          <span
            className="agent-usage"
            title={`当前上下文 ${chat.context_tokens.toLocaleString()} / ${model.context_window.toLocaleString()} token；本会话累计输入 ${chat.input_tokens.toLocaleString()}、输出 ${chat.output_tokens.toLocaleString()}`}
            data-testid="agent-usage"
          >
            {formatTokens(chat.context_tokens)} / {formatTokens(model.context_window)}
          </span>
        )}
        <IconButton label={listOpen ? '回到对话' : '全部对话'} active={listOpen} onClick={() => setListOpen(!listOpen)}>
          <History size={18} />
        </IconButton>
        <IconButton
          label="新对话"
          disabled={!activeId && !current && !listOpen}
          onClick={() => {
            setListOpen(false)
            void newChat()
          }}
          data-testid="agent-new-chat"
        >
          <MessageSquarePlus size={18} />
        </IconButton>
        {popup && (
          <>
            <IconButton label="展开到助手页" onClick={popup.onExpand} data-testid="agent-expand">
              <Maximize2 size={17} />
            </IconButton>
            <IconButton label="关闭助手" onClick={popup.onClose} data-testid="agent-popup-close">
              <X size={18} />
            </IconButton>
          </>
        )}
      </header>
      {listOpen ? (
        <div className="agent-thread">
          <ChatList onPicked={() => setListOpen(false)} />
        </div>
      ) : !ready ? (
        <div className="agent-center">
          <Spinner />
        </div>
      ) : noModels && !current?.messages.length ? (
        <NoModels secretKeySet={config.secret_key_set} />
      ) : (
        <>
          <Thread />
          <Composer contextPath={contextPath} mobile={mobile} autoFocus={focusInput} />
        </>
      )}
    </section>
  )
}

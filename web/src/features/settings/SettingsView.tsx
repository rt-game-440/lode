import { Check, Copy, KeyRound, Keyboard, RefreshCw, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { api } from '../../api/client'
import type { ApiToken, AuditEntry, TokenScope } from '../../api/types'
import { confirmDialog } from '../../components/overlays'
import { ListItem, ListPresence } from '../../components/AnimatedList'
import { Button, EmptyState, IconButton, Spinner, TextField } from '../../components/ui'
import { copyText } from '../../lib/clipboard'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../actions'
import { ViewBar } from '../views/Views'
import { AgentSection } from './AgentSettings'
import './settings.css'

const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const SCOPE_LABEL: Record<TokenScope, string> = { read: '只读', write: '读写' }
const SCOPE_HINT: Record<TokenScope, string> = {
  read: '可以搜索、阅读和列出笔记。',
  write: '还可以新建、修改、移动和删除笔记（删除的笔记进回收站）。',
}

function mcpEndpoint() {
  return `${location.origin}/mcp`
}

/** 复制并提示结果。 */
async function copyWithToast(text: string, what: string) {
  const ok = await copyText(text)
  useUI.getState().toast(ok ? { message: `已复制${what}`, tone: 'success' } : { message: '复制失败，请手动选择复制', tone: 'error' })
}

function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div className="copy-field">
      <code className="copy-field-value" data-testid={testId}>
        {value}
      </code>
      <IconButton label={`复制${label}`} size="sm" onClick={() => void copyWithToast(value, label)}>
        <Copy size={15} />
      </IconButton>
    </div>
  )
}

export function SettingsView({ mobile }: { mobile: boolean }) {
  // 刷新时 token 列表（最后使用时间）和调用记录一起重新加载；从 agent 那边切回来时也刷新
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])
  return (
    <section className="view">
      <ViewBar title="设置" mobile={mobile} />
      <div className="view-body settings">
        <AgentSection />
        <McpSection />
        <TokenSection version={version} />
        <AuditSection version={version} onRefresh={refresh} />
        <KeyboardSection />
      </div>
    </section>
  )
}

function KeyboardSection() {
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  return (
    <section className="settings-group" aria-labelledby="settings-keyboard">
      <h2 id="settings-keyboard" className="settings-heading">
        键盘
      </h2>
      <div className="settings-card">
        <div className="settings-row">
          <span className="settings-row-text">所有功能都可以只用键盘完成；不在输入时按 ? 随时查看。</span>
          <Button size="sm" variant="secondary" icon={<Keyboard size={14} />} onClick={() => setShortcutsOpen(true)}>
            键盘快捷键
          </Button>
        </div>
      </div>
    </section>
  )
}

function McpSection() {
  return (
    <section className="settings-group" aria-labelledby="settings-mcp">
      <h2 id="settings-mcp" className="settings-heading">
        MCP 接入
      </h2>
      <p className="settings-desc">
        Claude Code、Codex、Cursor 等 agent 可以通过 MCP 搜索、阅读和编辑你的笔记。先在下面创建 API token，再在 agent
        里添加这个地址，用 <code>Authorization: Bearer &lt;token&gt;</code> 请求头鉴权。
      </p>
      <div className="settings-card">
        <div className="settings-row">
          <span className="settings-row-label">地址</span>
          <CopyField value={mcpEndpoint()} label="MCP 地址" testId="mcp-endpoint" />
        </div>
      </div>
    </section>
  )
}

function TokenSection({ version }: { version: number }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [created, setCreated] = useState<{ token: ApiToken; secret: string } | null>(null)
  const toast = useUI((s) => s.toast)

  const load = useCallback(async () => {
    try {
      setTokens(await api.tokens())
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
      setTokens([])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load, version])

  const revoke = async (t: ApiToken) => {
    const ok = await confirmDialog({
      title: `吊销“${t.name}”？`,
      message: '使用这个 token 的 agent 会立即失去访问权限。吊销后无法恢复，需要时请重新创建。',
      confirmLabel: '吊销',
      danger: true,
    })
    if (!ok) return
    try {
      await api.revokeToken(t.id)
      setTokens((list) => list?.filter((x) => x.id !== t.id) ?? null)
      if (created?.token.id === t.id) setCreated(null)
      toast({ message: `已吊销“${t.name}”` })
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  return (
    <section className="settings-group" aria-labelledby="settings-tokens">
      <h2 id="settings-tokens" className="settings-heading">
        API token
      </h2>
      <p className="settings-desc">每个 agent 用一个单独的 token，方便在调用记录里区分，也可以单独吊销。</p>

      {created ? (
        <TokenReveal created={created} onDone={() => setCreated(null)} />
      ) : (
        <CreateTokenForm
          onCreated={(c) => {
            setCreated(c)
            setTokens((list) => [c.token, ...(list ?? [])])
          }}
        />
      )}

      <div className="settings-card">
        {!tokens ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !tokens.length ? (
          <EmptyState icon={<KeyRound size={28} strokeWidth={1.5} />} title="还没有 token" />
        ) : (
          <ul className="token-list" aria-label="API token 列表">
            <ListPresence>
              {tokens.map((t) => (
                <ListItem key={t.id} className="settings-row token-row">
                  <div className="token-info">
                    <span className="token-name">
                      {t.name}
                      <span className={`scope-badge scope-${t.scope}`}>{SCOPE_LABEL[t.scope]}</span>
                    </span>
                    <span className="settings-meta">
                      创建于 {dateFmt.format(t.created_at)} · {t.last_used_at ? `最后使用 ${dateFmt.format(t.last_used_at)}` : '从未使用'}
                    </span>
                  </div>
                  <Button size="sm" variant="secondary" className="btn-destructive" onClick={() => void revoke(t)}>
                    吊销
                  </Button>
                </ListItem>
              ))}
            </ListPresence>
          </ul>
        )}
      </div>
    </section>
  )
}

function CreateTokenForm({ onCreated }: { onCreated: (c: { token: ApiToken; secret: string }) => void }) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<TokenScope>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scopeLabelId = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请填写名称，例如 Claude Code')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createToken(name.trim(), scope))
      setName('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-card token-form" onSubmit={(e) => void submit(e)}>
      <TextField
        id="token-name"
        label="名称"
        placeholder="例如 Claude Code"
        maxLength={64}
        value={name}
        error={error}
        onChange={(e) => setName(e.target.value)}
        autoComplete="off"
      />
      <div className="field">
        <span className="field-label" id={scopeLabelId}>
          权限
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby={scopeLabelId}>
          {(['read', 'write'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={`segment${scope === s ? ' is-selected' : ''}`}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="settings-meta">{SCOPE_HINT[scope]}</p>
      </div>
      <div className="token-form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? '正在创建…' : '创建 token'}
        </Button>
      </div>
    </form>
  )
}

function TokenReveal({ created, onDone }: { created: { token: ApiToken; secret: string }; onDone: () => void }) {
  const command = `claude mcp add --transport http lode ${mcpEndpoint()} --header "Authorization: Bearer ${created.secret}"`
  return (
    <div className="settings-card token-reveal" role="status">
      <p className="token-reveal-title">
        <Check size={16} aria-hidden="true" />
        已创建“{created.token.name}”（{SCOPE_LABEL[created.token.scope]}）
      </p>
      <p className="settings-desc">token 只显示这一次，离开后无法再查看。请现在复制，保存到 agent 的配置里。</p>
      <CopyField value={created.secret} label="token" testId="token-secret" />
      <p className="settings-meta">Claude Code 可以直接运行：</p>
      <CopyField value={command} label="接入命令" />
      <div className="token-form-actions">
        <Button variant="secondary" onClick={onDone}>
          我已保存
        </Button>
      </div>
    </div>
  )
}

function AuditSection({ version, onRefresh }: { version: number; onRefresh: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const toast = useUI((s) => s.toast)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await api.audit(100))
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
      setEntries((e) => e ?? [])
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load, version])

  return (
    <section className="settings-group" aria-labelledby="settings-audit">
      <div className="settings-heading-row">
        <h2 id="settings-audit" className="settings-heading">
          调用记录
        </h2>
        <IconButton label="刷新调用记录" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'is-spinning' : undefined} />
        </IconButton>
      </div>
      <p className="settings-desc">agent 通过 MCP 调用工具的记录，保留最近 1000 条，这里显示最近 100 条。</p>
      <div className="settings-card">
        {!entries ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !entries.length ? (
          <EmptyState title="还没有调用记录">agent 通过 MCP 调用工具后会显示在这里</EmptyState>
        ) : (
          <table className="audit-table" aria-label="调用记录">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">token</th>
                <th scope="col">工具</th>
                <th scope="col">路径</th>
                <th scope="col">结果</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="audit-time">{timeFmt.format(e.at)}</td>
                  <td>{e.token_name}</td>
                  <td>
                    <code>{e.tool}</code>
                  </td>
                  <td className="audit-target" title={e.target}>
                    {e.target || '—'}
                  </td>
                  <td className={e.ok ? 'audit-ok' : 'audit-fail'} title={e.error}>
                    {e.ok ? (
                      <>
                        <Check size={14} aria-hidden="true" />
                        成功
                      </>
                    ) : (
                      <>
                        <X size={14} aria-hidden="true" />
                        失败
                        {e.error && <span className="audit-error">{e.error}</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

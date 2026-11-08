import { Check, KeyRound, RefreshCw, X } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { ApiToken, AuditEntry, TokenScope } from '../../api/types'
import { ListItem, ListPresence } from '../../components/AnimatedList'
import { confirmDialog } from '../../components/overlays'
import { Button, EmptyState, IconButton, Spinner, TextField } from '../../components/ui'
import { DEFAULT_WORKSPACE } from '../../lib/workspace'
import { useUI } from '../../stores/ui'
import { useWorkspace, workspaceName } from '../../stores/workspace'
import { errorMessage } from '../actions'
import { useSettingsData } from './data'
import { settingsBack } from './nav'
import { ActionRow, CopyField, Group, InfoRow, NavRow, SettingsPage } from './parts'
import { SECTION_TITLE } from './stack'

// 设置里的“agent 接入”：MCP 地址、API token（列表和单个 token）、调用记录。

export const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const SCOPE_LABEL: Record<TokenScope, string> = { read: '只读', write: '读写' }
const SCOPE_HINT: Record<TokenScope, string> = {
  read: '可以搜索、阅读和列出笔记。',
  write: '还可以新建、修改、移动和删除笔记（删除的笔记进回收站）。',
}

export function mcpEndpoint() {
  return `${location.origin}/mcp`
}

function ScopeBadge({ scope }: { scope: TokenScope }) {
  return <span className={`scope-badge scope-${scope}`}>{SCOPE_LABEL[scope]}</span>
}

/** token 所属工作空间的名称（列表里没有时显示 id）。 */
function useWorkspaceName(id: string) {
  return useWorkspace((s) => workspaceName(s.list, id))
}

function lastUsed(t: ApiToken) {
  return t.last_used_at ? `最后使用 ${dateFmt.format(t.last_used_at)}` : '从未使用'
}

/* ---------------- MCP 接入 ---------------- */

export function McpPage({ sub }: { sub: string[] }) {
  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.mcp}>
      <Group
        title="地址"
        footer={
          <>
            先在“API token”里创建 token，再在 agent 里添加这个地址，用 <code>Authorization: Bearer &lt;token&gt;</code> 请求头鉴权。
            每个 token 绑定一个工作空间，agent 只能访问它绑定的那个。
          </>
        }
      >
        <div className="settings-row">
          <CopyField value={mcpEndpoint()} label="MCP 地址" testId="mcp-endpoint" />
        </div>
      </Group>
      <p className="settings-desc">Claude Code、Codex、Cursor 等 agent 可以通过 MCP 搜索、阅读和编辑你的笔记。</p>
    </SettingsPage>
  )
}

/* ---------------- API token ---------------- */

export function TokensPage({ sub }: { sub: string[] }) {
  const tokens = useSettingsData((s) => s.tokens)
  const addToken = useSettingsData((s) => s.addToken)
  const [created, setCreated] = useState<{ token: ApiToken; secret: string } | null>(null)
  // 刚创建的 token 在详情页里被吊销了：不再显示明文
  const reveal = created && (!tokens || tokens.some((t) => t.id === created.token.id)) ? created : null

  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.tokens}>
      <p className="settings-desc">
        每个 agent 用一个单独的 token，方便在调用记录里区分，也可以单独吊销。每个 token 绑定一个工作空间，只能访问那里的笔记。
      </p>
      {reveal ? (
        <TokenReveal created={reveal} onDone={() => setCreated(null)} />
      ) : (
        <CreateTokenForm
          onCreated={(c) => {
            setCreated(c)
            addToken(c.token)
          }}
        />
      )}

      <Group title="已创建的 token">
        {!tokens ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !tokens.length ? (
          <EmptyState icon={<KeyRound size={28} strokeWidth={1.5} />} title="还没有 token" />
        ) : (
          <ul className="settings-list token-list" aria-label="API token 列表">
            <ListPresence>
              {tokens.map((t) => (
                <ListItem key={t.id}>
                  <TokenRow token={t} />
                </ListItem>
              ))}
            </ListPresence>
          </ul>
        )}
      </Group>
    </SettingsPage>
  )
}

function TokenRow({ token: t }: { token: ApiToken }) {
  const ws = useWorkspaceName(t.workspace)
  return (
    <NavRow
      to={['tokens', t.id]}
      testId="token-row"
      label={
        <span className="token-name">
          {t.name}
          <ScopeBadge scope={t.scope} />
        </span>
      }
      meta={`工作空间：${ws} · 创建于 ${dateFmt.format(t.created_at)} · ${lastUsed(t)}`}
    />
  )
}

function CreateTokenForm({ onCreated }: { onCreated: (c: { token: ApiToken; secret: string }) => void }) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<TokenScope>('read')
  const workspaces = useWorkspace((s) => s.list)
  const currentWs = useWorkspace((s) => s.current)
  // 默认绑定当前工作空间；用户改过就保持他的选择（所选的被删除后回到默认工作空间）
  const [picked, setPicked] = useState<string | null>(null)
  const workspace = workspaces.some((w) => w.id === (picked ?? currentWs)) ? (picked ?? currentWs) : DEFAULT_WORKSPACE
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scopeLabelId = useId()
  const workspaceId = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请填写名称，例如 Claude Code')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createToken(name.trim(), scope, workspace))
      setName('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group title="新建 token">
      <form className="token-form" onSubmit={(e) => void submit(e)}>
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
          <label className="field-label" htmlFor={workspaceId}>
            工作空间
          </label>
          <select
            id={workspaceId}
            className="settings-select token-workspace"
            value={workspace}
            onChange={(e) => setPicked(e.target.value)}
            data-testid="token-workspace"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <p className="settings-meta">这个 token 只能访问所选工作空间里的笔记。</p>
        </div>
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
    </Group>
  )
}

function TokenReveal({ created, onDone }: { created: { token: ApiToken; secret: string }; onDone: () => void }) {
  const ws = useWorkspaceName(created.token.workspace)
  const command = `claude mcp add --transport http lode ${mcpEndpoint()} --header "Authorization: Bearer ${created.secret}"`
  return (
    <div className="settings-card token-reveal" role="status">
      <p className="token-reveal-title">
        <Check size={16} aria-hidden="true" />
        已创建“{created.token.name}”（{SCOPE_LABEL[created.token.scope]}，工作空间：{ws}）
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

/* ---------------- 单个 token ---------------- */

export function TokenPage({ sub, id }: { sub: string[]; id: string }) {
  const tokens = useSettingsData((s) => s.tokens)
  const audit = useSettingsData((s) => s.audit)
  const removeToken = useSettingsData((s) => s.removeToken)
  const toast = useUI((s) => s.toast)
  const workspaces = useWorkspace((s) => s.list)
  // 吊销后列表里已经没有它，但退出动画期间仍显示原来的内容
  const last = useRef<ApiToken | null>(null)
  const found = tokens?.find((t) => t.id === id) ?? null
  if (found) last.current = found
  const t = found ?? last.current

  if (!t) {
    return (
      <SettingsPage sub={sub} title="API token">
        {!tokens ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : (
          <EmptyState icon={<KeyRound size={28} strokeWidth={1.5} />} title="找不到这个 token">
            它可能已经被吊销
          </EmptyState>
        )}
      </SettingsPage>
    )
  }

  const calls = (audit ?? []).filter((e) => e.token_id === t.id).slice(0, 20)

  const revoke = async () => {
    const ok = await confirmDialog({
      title: `吊销“${t.name}”？`,
      message: '使用这个 token 的 agent 会立即失去访问权限。吊销后无法恢复，需要时请重新创建。',
      confirmLabel: '吊销',
      danger: true,
    })
    if (!ok) return
    try {
      await api.revokeToken(t.id)
      removeToken(t.id)
      toast({ message: `已吊销“${t.name}”` })
      settingsBack(sub)
    } catch (err) {
      toast({ message: errorMessage(err), tone: 'error' })
    }
  }

  return (
    <SettingsPage sub={sub} title={t.name} testId="token-detail">
      <Group footer={`${SCOPE_HINT[t.scope]}只能访问“${workspaceName(workspaces, t.workspace)}”这个工作空间。`}>
        <InfoRow label="名称">{t.name}</InfoRow>
        <InfoRow label="权限">
          <ScopeBadge scope={t.scope} />
        </InfoRow>
        <InfoRow label="工作空间">
          <span data-testid="token-workspace-name">{workspaceName(workspaces, t.workspace)}</span>
        </InfoRow>
        <InfoRow label="创建于">{dateFmt.format(t.created_at)}</InfoRow>
        <InfoRow label="最后使用">{t.last_used_at ? dateFmt.format(t.last_used_at) : '从未使用'}</InfoRow>
      </Group>
      <Group title="最近调用" footer="最近 100 条调用记录里属于这个 token 的部分。">
        {!audit ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !calls.length ? (
          <EmptyState title="还没有调用记录" />
        ) : (
          <AuditTable entries={calls} label={`“${t.name}”的调用记录`} showToken={false} />
        )}
      </Group>
      <Group footer="使用这个 token 的 agent 会立即失去访问权限，吊销后无法恢复。">
        <ActionRow danger onClick={() => void revoke()}>
          吊销
        </ActionRow>
      </Group>
    </SettingsPage>
  )
}

/* ---------------- 调用记录 ---------------- */

export function AuditPage({ sub }: { sub: string[] }) {
  const entries = useSettingsData((s) => s.audit)
  const loading = useSettingsData((s) => s.auditLoading)
  const loadAudit = useSettingsData((s) => s.loadAudit)
  const loadTokens = useSettingsData((s) => s.loadTokens)
  const refresh = () => {
    void loadAudit()
    // token 的“最后使用”时间也跟着刷新
    void loadTokens()
  }
  return (
    <SettingsPage
      sub={sub}
      title={SECTION_TITLE.audit}
      testId="audit-page"
      actions={
        <IconButton label="刷新调用记录" onClick={refresh} disabled={loading}>
          <RefreshCw size={17} className={loading ? 'is-spinning' : undefined} />
        </IconButton>
      }
    >
      <p className="settings-desc">agent 通过 MCP 调用工具的记录（含调用发生的工作空间），保留最近 1000 条，这里显示最近 100 条。</p>
      <div className="settings-card">
        {!entries ? (
          <div className="view-loading">
            <Spinner />
          </div>
        ) : !entries.length ? (
          <EmptyState title="还没有调用记录">agent 通过 MCP 调用工具后会显示在这里</EmptyState>
        ) : (
          <AuditTable entries={entries} label="调用记录" showToken />
        )}
      </div>
    </SettingsPage>
  )
}

function AuditTable({ entries, label, showToken }: { entries: AuditEntry[]; label: string; showToken: boolean }) {
  const workspaces = useWorkspace((s) => s.list)
  return (
    <table className="audit-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">时间</th>
          {showToken && <th scope="col">token</th>}
          <th scope="col">工具</th>
          <th scope="col">路径</th>
          <th scope="col">结果</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td className="audit-time">{timeFmt.format(e.at)}</td>
            {showToken && (
              <td>
                {e.token_name}
                <span className="audit-ws" data-testid="audit-workspace">
                  {workspaceName(workspaces, e.workspace)}
                </span>
              </td>
            )}
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
  )
}

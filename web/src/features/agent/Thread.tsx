import {
  AlertCircle,
  Check,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderInput,
  Hash,
  Link2,
  List,
  Paperclip,
  Pencil,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import type { Draft, Message, Pending, ToolCall, ToolResult } from '../../api/agent'
import { Button, Spinner } from '../../components/ui'
import { basename } from '../../lib/paths'
import { useAgent } from '../../stores/agent'
import { findByPath, useVault } from '../../stores/vault'
import { openNote, openWikiLink } from '../actions'
import { Markdown } from './Markdown'
import { userText } from './chatState'

const TOOL_LABEL: Record<string, { label: string; icon: typeof Search }> = {
  search_notes: { label: '搜索笔记', icon: Search },
  read_note: { label: '读取笔记', icon: FileText },
  list_notes: { label: '列出笔记', icon: List },
  create_note: { label: '新建笔记', icon: FilePlus2 },
  update_note: { label: '修改笔记', icon: Pencil },
  move_note: { label: '移动笔记', icon: FolderInput },
  delete_note: { label: '删除笔记', icon: Trash2 },
  get_backlinks: { label: '查找反链', icon: Link2 },
  list_tags: { label: '列出标签', icon: Hash },
}

function toolMeta(name: string) {
  return TOOL_LABEL[name] ?? { label: name, icon: Wrench }
}

/** 工具调用的一行摘要：搜索词、路径或文件夹。 */
export function toolSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const v = a.query ?? a.path ?? a.folder ?? a.tag ?? ''
  const to = typeof a.to === 'string' ? ` → ${a.to}` : ''
  return typeof v === 'string' ? v + to : ''
}

const RESULT_LIMIT = 4000

function ToolCard({ call, result, running }: { call: ToolCall; result?: ToolResult; running: boolean }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const { label, icon: Icon } = toolMeta(call.name)
  const summary = toolSummary(call.args)
  const status = result ? (
    result.is_error ? (
      <AlertCircle size={14} className="tool-status is-error" aria-label="失败" />
    ) : (
      <Check size={14} className="tool-status is-ok" aria-label="完成" />
    )
  ) : running ? (
    <Spinner size={12} />
  ) : null
  const content = result?.content ?? ''
  return (
    <div className={`tool-card${open ? ' is-open' : ''}`} data-testid="tool-card">
      <button type="button" className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="tool-chevron" aria-hidden="true" />
        <Icon size={14} aria-hidden="true" />
        <span className="tool-label">{label}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {status}
      </button>
      {open && (
        <div className="tool-body" id={bodyId}>
          <div className="tool-section-label">参数</div>
          <pre className="tool-pre">{JSON.stringify(call.args, null, 2)}</pre>
          {result && (
            <>
              <div className="tool-section-label">{result.is_error ? '错误' : '结果'}</div>
              <pre className="tool-pre">
                {content.length > RESULT_LIMIT ? `${content.slice(0, RESULT_LIMIT)}\n…（共 ${content.length} 字，只显示开头）` : content}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <div className={`thinking${open ? ' is-open' : ''}`}>
      <button type="button" className="thinking-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="tool-chevron" aria-hidden="true" />
        {streaming ? <span className="thinking-live">正在思考…</span> : '思考过程'}
      </button>
      {open && (
        <div className="thinking-body" id={bodyId}>
          {text}
        </div>
      )}
    </div>
  )
}

const goWiki = (target: string) => void openWikiLink(target, '')

/** 助手消息的各个片段：思考、正文、工具调用，按生成顺序排列。 */
function AssistantParts({
  parts,
  results,
  streaming,
}: {
  parts: Message['parts']
  results: Map<string, ToolResult>
  streaming: boolean
}) {
  return (
    <>
      {parts.map((p, i) => {
        const last = i === parts.length - 1
        switch (p.type) {
          case 'thinking':
            return p.text ? <Thinking key={i} text={p.text} streaming={streaming && last} /> : null
          case 'text':
            return p.text ? <Markdown key={i} source={p.text} onWikiLink={goWiki} /> : null
          case 'tool_call':
            return p.call ? <ToolCard key={i} call={p.call} result={results.get(p.call.id)} running={streaming || !results.has(p.call.id)} /> : null
        }
        return null
      })}
    </>
  )
}

function MentionChip({ path }: { path: string }) {
  const note = useVault((s) => findByPath(s.notes, path))
  return (
    <button type="button" className="mention-chip" onClick={() => note && openNote(note.id)} disabled={!note} title={path}>
      <FileText size={12} aria-hidden="true" />
      {note?.title ?? basename(path).replace(/\.md$/i, '')}
    </button>
  )
}

export function MessageView({ m, results, running }: { m: Message; results: Map<string, ToolResult>; running: boolean }) {
  if (m.role === 'user') {
    const text = userText(m)
    const media = m.parts.filter((p) => p.type === 'media' && p.media)
    return (
      <div className="msg msg-user" data-testid="msg-user">
        {(m.meta.mentions?.length || media.length) > 0 && (
          <div className="msg-chips">
            {m.meta.mentions?.map((p) => <MentionChip key={p} path={p} />)}
            {media.map((p, i) => (
              <span key={i} className="mention-chip is-static">
                <Paperclip size={12} aria-hidden="true" />
                {p.media?.name || p.media?.mime}
              </span>
            ))}
          </div>
        )}
        {text && <div className="msg-bubble">{text}</div>}
      </div>
    )
  }
  return (
    <div className="msg msg-assistant" data-testid="msg-assistant">
      <AssistantParts parts={m.parts} results={results} streaming={false} />
      {m.meta.stopped && <p className="msg-note">已停止</p>}
      {m.meta.error && (
        <p className="msg-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {m.meta.error}
        </p>
      )}
      {!m.meta.stopped && !m.meta.error && !m.parts.length && running && <Spinner />}
    </div>
  )
}

/** 正在生成的草稿：思考在前，正文其次，工具调用最后（与各家流式输出的顺序一致）。 */
export function DraftView({ draft }: { draft: Draft }) {
  const parts: Message['parts'] = []
  if (draft.thinking) parts.push({ type: 'thinking', text: draft.thinking })
  if (draft.text) parts.push({ type: 'text', text: draft.text })
  for (const c of draft.calls ?? []) parts.push({ type: 'tool_call', call: c })
  return (
    <div className="msg msg-assistant is-streaming" data-testid="msg-draft" aria-live="polite" aria-busy="true">
      {parts.length ? <AssistantParts parts={parts} results={new Map()} streaming /> : <span className="typing" aria-label="正在回复"><i /><i /><i /></span>}
    </div>
  )
}

const ACTION_TEXT: Record<Pending['preview']['action'], string> = {
  create: '新建',
  update: '修改',
  move: '移动',
  delete: '删除（移到回收站）',
}

export function ApprovalCard({ p }: { p: Pending }) {
  const resolve = useAgent((s) => s.resolve)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const titleId = useId()
  const act = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject')
    await resolve(p.call_id, approve)
    setBusy(null)
  }
  const { preview } = p
  return (
    <section className="approval" aria-labelledby={titleId} data-testid="approval-card">
      <header className="approval-head">
        <span id={titleId} className="approval-title">
          助手想要{ACTION_TEXT[preview.action]}
        </span>
        <span className="approval-path" title={preview.path}>
          {preview.path}
          {preview.to ? ` → ${preview.to}` : ''}
        </span>
      </header>
      {preview.error && (
        <p className="approval-error">
          <AlertCircle size={14} aria-hidden="true" />
          {preview.error}
        </p>
      )}
      {preview.diff && preview.diff.length > 0 && <Diff lines={preview.diff} />}
      <div className="approval-actions">
        <Button size="sm" variant="secondary" icon={<X size={14} />} disabled={busy !== null} onClick={() => void act(false)}>
          {busy === 'reject' ? '正在拒绝…' : '拒绝'}
        </Button>
        <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={busy !== null} onClick={() => void act(true)}>
          {busy === 'approve' ? '正在执行…' : '批准'}
        </Button>
      </div>
    </section>
  )
}

const OP_LABEL: Record<string, string> = { '+': '新增', '-': '删除' }

function Diff({ lines }: { lines: NonNullable<Pending['preview']['diff']> }) {
  return (
    <div className="diff" role="table" aria-label="改动">
      {lines.map((l, i): ReactNode => {
        if (l.op === '…')
          return (
            <div key={i} className="diff-line is-skip" role="row">
              <span role="cell">⋯ {l.text} 行未改动</span>
            </div>
          )
        const cls = l.op === '+' ? 'is-add' : l.op === '-' ? 'is-del' : ''
        return (
          <div key={i} className={`diff-line ${cls}`} role="row">
            <span className="diff-op" role="cell" aria-label={OP_LABEL[l.op]}>
              {l.op === ' ' ? '' : l.op}
            </span>
            <span className="diff-text" role="cell">
              {l.text || ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}

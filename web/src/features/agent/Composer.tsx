import { ArrowUp, AtSign, FileText, Image, Paperclip, Square, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Attachment, EFFORT_LABEL, type Effort, type Modality } from '../../api/agent'
import type { Note } from '../../api/types'
import { Modal } from '../../components/Modal'
import { openMenu } from '../../components/overlays'
import { IconButton } from '../../components/ui'
import { chatModel, enabledModels, useAgent } from '../../stores/agent'
import { useAgentDraft } from '../../stores/agentDraft'
import { useUI } from '../../stores/ui'
import { findByPath, useVault } from '../../stores/vault'
import { VaultImagePicker } from './VaultImagePicker'
import { fileToAttachment } from './attachments'

const MAX_ATTACH = 20 << 20

const MODALITY_ACCEPT: Record<Exclude<Modality, 'text'>, string> = {
  image: 'image/*',
  pdf: 'application/pdf',
  audio: 'audio/*',
}

function modalityOf(mime: string): Modality | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  return null
}

/** base64 的原始字节数。 */
const rawSize = (a: Attachment) => Math.floor((a.data.length * 3) / 4)

/** 选择要 @ 的笔记：按标题和路径过滤，方向键选择，回车确认。 */
function NotePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (n: Note) => void }) {
  const notes = useVault((s) => s.notes)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listId = useId()
  const items = useMemo(() => {
    const all = Object.values(notes)
    const k = q.trim().toLowerCase()
    const hit = k ? all.filter((n) => n.title.toLowerCase().includes(k) || n.path.toLowerCase().includes(k)) : all
    return hit.sort((a, b) => b.mtime - a.mtime).slice(0, 30)
  }, [notes, q])
  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
    }
  }, [open])
  const pick = (n?: Note) => {
    if (!n) return
    onPick(n)
    onClose()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      pick(items[sel])
    }
  }
  return (
    <Modal open={open} onClose={onClose} label="选择要附上的笔记" className="note-picker">
      <input
        className="note-picker-input"
        placeholder="搜索笔记标题或路径"
        value={q}
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={items[sel] ? `${listId}-${sel}` : undefined}
        onChange={(e) => {
          setQ(e.target.value)
          setSel(0)
        }}
        onKeyDown={onKey}
      />
      <ul className="note-picker-list" id={listId} role="listbox" aria-label="笔记">
        {items.map((n, i) => (
          <li
            key={n.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === sel}
            className={i === sel ? 'is-selected' : ''}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(n)}
          >
            <FileText size={14} aria-hidden="true" />
            <span className="note-picker-title">{n.title}</span>
            <span className="note-picker-path">{n.path}</span>
          </li>
        ))}
        {!items.length && <li className="note-picker-empty">没有找到笔记</li>}
      </ul>
    </Modal>
  )
}

export function Composer({ contextPath, mobile, autoFocus }: { contextPath: string | null; mobile: boolean; autoFocus?: boolean }) {
  const config = useAgent((s) => s.config)
  const current = useAgent((s) => s.current)
  const send = useAgent((s) => s.send)
  const stop = useAgent((s) => s.stop)
  const setModel = useAgent((s) => s.setModel)
  const setEffort = useAgent((s) => s.setEffort)
  const toast = useUI((s) => s.toast)
  const notes = useVault((s) => s.notes)

  // 草稿在全局：弹窗和助手页之间切换时带过去（见 stores/agentDraft）
  const { text, withContext, mentions, attachments, setText, setWithContext, setMentions, setAttachments } = useAgentDraft()
  const [picker, setPicker] = useState(false)
  const [imagePicker, setImagePicker] = useState(false)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const model = chatModel(config, current?.chat)
  const models = enabledModels(config)
  const running = current?.running ?? false
  const contextNote = contextPath ? findByPath(notes, contextPath) : undefined
  const accepts = (model?.modalities ?? []).filter((m): m is Exclude<Modality, 'text'> => m !== 'text')

  // 输入框随内容长高，最多 8 行
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const allMentions = [...(withContext && contextNote ? [contextNote.path] : []), ...mentions.filter((p) => p !== contextNote?.path || !withContext)]
  const canSend = !running && !sending && (text.trim() !== '' || attachments.length > 0) && !!model

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    const ok = await send(text.trim(), allMentions, attachments)
    setSending(false)
    if (ok) {
      useAgentDraft.getState().clear()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    // 桌面回车发送、Shift+回车换行；手机回车换行，用发送按钮发送
    if (e.key === 'Enter' && !e.shiftKey && !mobile) {
      e.preventDefault()
      void submit()
    }
  }

  const onChange = (v: string) => {
    // 在行首或空白后输入 @ 时打开笔记选择
    const el = input.current
    const pos = el?.selectionStart ?? v.length
    if (v.length === text.length + 1 && v[pos - 1] === '@' && (pos === 1 || /\s/.test(v[pos - 2]))) {
      setText(v.slice(0, pos - 1) + v.slice(pos))
      setPicker(true)
      return
    }
    setText(v)
  }

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    const next = [...attachments]
    for (const f of list) {
      const mod = modalityOf(f.type)
      if (!mod || !model?.modalities.includes(mod)) {
        toast({ message: `当前模型不支持 ${f.type || f.name} 类型的附件`, tone: 'error' })
        continue
      }
      try {
        next.push(await fileToAttachment(f, f.name))
      } catch (err) {
        toast({ message: `读取 ${f.name} 失败：${err instanceof Error ? err.message : String(err)}`, tone: 'error' })
      }
    }
    if (next.reduce((s, a) => s + rawSize(a), 0) > MAX_ATTACH) {
      toast({ message: '附件合计不能超过 20MB', tone: 'error' })
      return
    }
    setAttachments(next)
  }

  const attachLabel = !model
    ? '还没有选择模型'
    : accepts.length
      ? `添加附件（${accepts.map((m) => ({ image: '图片', pdf: 'PDF', audio: '音频' })[m]).join('、')}）`
      : `${model.name || model.model} 只支持文字输入，不能添加附件`

  const onAttach = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!accepts.includes('image')) {
      fileInput.current?.click()
      return
    }
    openMenu(e.currentTarget, [
      { label: '从设备选择…', icon: <Paperclip size={16} />, run: () => fileInput.current?.click() },
      { label: '笔记库里的图片…', icon: <Image size={16} />, run: () => setImagePicker(true) },
    ])
  }

  return (
    <div className="composer">
      {(allMentions.length > 0 || attachments.length > 0 || (contextNote && !withContext)) && (
        <div className="composer-chips">
          {withContext && contextNote && (
            <span className="mention-chip is-context" title={`${contextNote.path}（当前笔记）`}>
              <FileText size={12} aria-hidden="true" />
              {contextNote.title}
              <button type="button" className="chip-x" aria-label={`不附上“${contextNote.title}”`} onClick={() => setWithContext(false)}>
                <X size={12} />
              </button>
            </span>
          )}
          {mentions
            .filter((p) => p !== contextNote?.path || !withContext)
            .map((p) => {
              const n = findByPath(notes, p)
              const title = n?.title ?? p
              return (
                <span key={p} className="mention-chip" title={p}>
                  <FileText size={12} aria-hidden="true" />
                  {title}
                  <button type="button" className="chip-x" aria-label={`不附上“${title}”`} onClick={() => setMentions((m) => m.filter((x) => x !== p))}>
                    <X size={12} />
                  </button>
                </span>
              )
            })}
          {contextNote && !withContext && (
            <button type="button" className="mention-chip is-ghost" onClick={() => setWithContext(true)}>
              <FileText size={12} aria-hidden="true" />
              附上当前笔记
            </button>
          )}
          {attachments.map((a, i) => (
            <span key={i} className="mention-chip" title={a.mime}>
              <Paperclip size={12} aria-hidden="true" />
              {a.name}
              <button type="button" className="chip-x" aria-label={`移除附件“${a.name}”`} onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        className="composer-input"
        rows={1}
        placeholder={model ? '问助手，@ 附上笔记' : '先在设置里添加模型'}
        aria-label="给助手的消息"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault()
            void addFiles(e.clipboardData.files)
          }
        }}
        autoFocus={autoFocus}
        data-testid="agent-input"
      />
      <div className="composer-bar">
        <IconButton label="附上笔记（@）" size="sm" onClick={() => setPicker(true)}>
          <AtSign size={16} />
        </IconButton>
        <span className="composer-attach" title={accepts.length ? undefined : attachLabel}>
          <IconButton label={attachLabel} size="sm" disabled={!accepts.length || running} onClick={onAttach}>
            <Paperclip size={16} />
          </IconButton>
        </span>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept={accepts.map((m) => MODALITY_ACCEPT[m]).join(',')}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {models.length > 0 && (
          <select
            className="composer-select"
            aria-label="模型"
            value={model?.id ?? ''}
            disabled={running}
            onChange={(e) => void setModel(e.target.value)}
            data-testid="model-select"
          >
            {!model && <option value="">选择模型</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.model}
                {models.some((x) => x.provider.id !== m.provider.id) ? ` · ${m.provider.name}` : ''}
              </option>
            ))}
          </select>
        )}
        {model?.reasoning && (
          <select
            className="composer-select"
            aria-label="推理强度"
            value={current?.chat.effort ?? ''}
            disabled={running}
            onChange={(e) => void setEffort(e.target.value as Effort | '')}
            data-testid="effort-select"
          >
            <option value="">推理：{EFFORT_LABEL[model.effort]}（默认）</option>
            {(Object.keys(EFFORT_LABEL) as Effort[]).map((k) => (
              <option key={k} value={k}>
                推理：{EFFORT_LABEL[k]}
              </option>
            ))}
          </select>
        )}
        <span className="composer-spacer" />
        {running ? (
          <IconButton label="停止" className="composer-send is-stop" onClick={() => void stop()} data-testid="agent-stop">
            <Square size={14} fill="currentColor" />
          </IconButton>
        ) : (
          <IconButton label="发送" className="composer-send" disabled={!canSend} onClick={() => void submit()} data-testid="agent-send">
            <ArrowUp size={18} />
          </IconButton>
        )}
      </div>
      <NotePicker
        open={picker}
        onClose={() => {
          setPicker(false)
          input.current?.focus()
        }}
        onPick={(n) => {
          if (n.path === contextNote?.path) setWithContext(true)
          else setMentions((m) => (m.includes(n.path) ? m : [...m, n.path]))
        }}
      />
      <VaultImagePicker
        open={imagePicker}
        onClose={() => setImagePicker(false)}
        onPick={(a) => {
          if (attachments.reduce((s, x) => s + rawSize(x), 0) + rawSize(a) > MAX_ATTACH) {
            toast({ message: '附件合计不能超过 20MB', tone: 'error' })
            return
          }
          setAttachments((l) => [...l, a])
        }}
      />
    </div>
  )
}

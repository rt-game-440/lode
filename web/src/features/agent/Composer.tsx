import { ArrowUp, AtSign, FileText, Image, Paperclip, Square, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Modality } from '../../api/agent'
import { openMenu } from '../../components/overlays'
import { IconButton } from '../../components/ui'
import { usePop } from '../../components/usePop'
import { chatModel, useAgent } from '../../stores/agent'
import { useAgentDraft } from '../../stores/agentDraft'
import { useUI } from '../../stores/ui'
import { findByPath, useVault } from '../../stores/vault'
import { springSnappy } from '../../styles/tokens/motion'
import { ModelPicker } from './ModelPicker'
import { VaultImagePicker } from './VaultImagePicker'
import { fileToAttachment } from './attachments'
import { filterNotes, findMention, resolveMentions, sentMentions } from './mention'

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

export function Composer({ contextPath, mobile, autoFocus }: { contextPath: string | null; mobile: boolean; autoFocus?: boolean }) {
  const config = useAgent((s) => s.config)
  const current = useAgent((s) => s.current)
  const send = useAgent((s) => s.send)
  const stop = useAgent((s) => s.stop)
  const toast = useUI((s) => s.toast)
  const notes = useVault((s) => s.notes)

  // 草稿在全局：弹窗和助手页之间切换时带过去（见 stores/agentDraft）
  const { text, mentions, attachments, suppressed, setText, setMentions, setAttachments } = useAgentDraft()
  const [imagePicker, setImagePicker] = useState(false)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // @ 补全：光标位置、输入框是否有焦点、被 Esc 关掉的那个 @ 的位置、高亮项
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [sel, setSel] = useState(0)
  const pendingCaret = useRef<number | null>(null)
  const listId = useId()
  const pop = usePop({ scale: 0.97, y: 4 })

  const model = chatModel(config, current?.chat)
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

  // 插入文字 / 选中补全项后，把光标放到约定的位置
  useLayoutEffect(() => {
    const pos = pendingCaret.current
    const el = input.current
    if (pos === null || !el) return
    pendingCaret.current = null
    el.focus()
    el.setSelectionRange(pos, pos)
    setCaret(pos)
  }, [text])

  // 当前笔记只在第一次发送时自动附上；用户移除过、或之前的消息已经附过，就不再自动附上（#44）
  const sent = useMemo(() => sentMentions(current?.messages), [current?.messages])
  const { all: allMentions } = resolveMentions({ contextPath: contextNote?.path, mentions, suppressed, sent })
  const canSend = !running && !sending && (text.trim() !== '' || attachments.length > 0) && !!model

  const mention = findMention(text, Math.min(caret, text.length))
  const listOpen = focused && !!mention && mention.start !== dismissed
  const attachedKey = allMentions.join('\n')
  const query = mention?.query
  const items = useMemo(() => (listOpen && query !== undefined ? filterNotes(notes, query, attachedKey ? attachedKey.split('\n') : []) : []), [listOpen, query, notes, attachedKey])
  const activeIndex = Math.min(sel, Math.max(0, items.length - 1))
  const optionId = (i: number) => `${listId}-${i}`

  useEffect(() => {
    if (!mention) setDismissed(null)
  }, [mention])
  useEffect(() => setSel(0), [query])
  useEffect(() => {
    if (listOpen) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [listOpen, activeIndex, listId])

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    const ok = await send(text.trim(), allMentions, attachments)
    setSending(false)
    if (ok) {
      // 这一轮附过的笔记不再自动附上
      useAgentDraft.getState().suppress(allMentions)
      useAgentDraft.getState().clear()
    }
  }

  const pick = (path: string) => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    let after = text.slice(caret)
    // @ 前后都是空格时去掉一个，免得留下双空格
    if (before.endsWith(' ') && after.startsWith(' ')) after = after.slice(1)
    pendingCaret.current = before.length
    setText(before + after)
    setMentions((m) => (m.includes(path) ? m : [...m, path]))
  }

  const removeMention = (path: string) => {
    setMentions((m) => m.filter((x) => x !== path))
    useAgentDraft.getState().suppress([path])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (listOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (items.length) {
          e.preventDefault()
          setSel((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        }
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && items.length) {
        e.preventDefault()
        pick(items[activeIndex].path)
        return
      }
      if (e.key === 'Escape' && mention) {
        // 只关补全；弹窗的 Esc 处理会跳过已 preventDefault 的按键
        e.preventDefault()
        e.stopPropagation()
        setDismissed(mention.start)
        return
      }
    }
    // 桌面回车发送、Shift+回车换行；手机回车换行，用发送按钮发送
    if (e.key === 'Enter' && !e.shiftKey && !mobile) {
      e.preventDefault()
      void submit()
    }
  }

  // 点 @ 按钮等同于在光标处输入一个 @（前面不是空白时先补一个空格）
  const insertAt = () => {
    const el = input.current
    if (!el) return
    if (listOpen && mention) {
      setDismissed(mention.start)
      el.focus()
      return
    }
    const pos = el.selectionStart ?? text.length
    const before = text.slice(0, pos)
    const ins = (before && !/\s$/.test(before) ? ' ' : '') + '@'
    pendingCaret.current = pos + ins.length
    setText(before + ins + text.slice(pos))
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

  const showGhost = !!contextNote && !allMentions.includes(contextNote.path)

  return (
    <div className="composer">
      <AnimatePresence>
        {listOpen && mention && (
          <motion.div
            className="mention-menu"
            data-testid="mention-menu"
            {...pop}
            transition={springSnappy}
            // 点列表时输入框不失焦，焦点始终留在输入框
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.length > 0 ? (
              <ul id={listId} role="listbox" aria-label="笔记" className="mention-list" tabIndex={0}>
                {items.map((n, i) => (
                  <li
                    key={n.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={i === activeIndex ? 'is-selected' : ''}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => pick(n.path)}
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span className="mention-title">{n.title}</span>
                    <span className="mention-path">{n.path}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mention-empty">没有找到笔记</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {(allMentions.length > 0 || attachments.length > 0 || showGhost) && (
        <div className="composer-chips">
          {allMentions.map((p) => {
            const n = findByPath(notes, p)
            const title = n?.title ?? p
            const isContext = p === contextNote?.path
            return (
              <span key={p} className={`mention-chip${isContext ? ' is-context' : ''}`} title={isContext ? `${p}（当前笔记）` : p}>
                <FileText size={12} aria-hidden="true" />
                {title}
                <button type="button" className="chip-x" aria-label={`不附上“${title}”`} onClick={() => removeMention(p)}>
                  <X size={12} />
                </button>
              </span>
            )
          })}
          {showGhost && contextNote && (
            <button
              type="button"
              className="mention-chip is-ghost"
              title={`${contextNote.path}（当前笔记）`}
              onClick={() => setMentions((m) => (m.includes(contextNote.path) ? m : [...m, contextNote.path]))}
            >
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
        aria-autocomplete="list"
        data-own-escape={listOpen ? 'true' : undefined}
        aria-controls={listOpen && items.length ? listId : undefined}
        aria-activedescendant={listOpen && items.length ? optionId(activeIndex) : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
        {/* mousedown 不夺走输入框的焦点（手机上软键盘不收起） */}
        <IconButton label="附上笔记（@）" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={insertAt} data-testid="agent-at">
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
        <ModelPicker />
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

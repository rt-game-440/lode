import { ArrowRightLeft, FilePlus, FileText, Plus, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { usePop } from '../../components/usePop'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note, WorkspaceInfo } from '../../api/types'
import { dirname, invalidNameReason } from '../../lib/paths'
import { fuzzyScore } from '../../lib/snippet'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { useWorkspace } from '../../stores/workspace'
import { fadeTransition, springSnappy } from '../../styles/tokens/motion'
import { newNote, openNote, recentIds } from '../actions'
import { promptCreateWorkspace, switchWorkspace } from '../workspace/WorkspaceSwitcher'
import './switcher.css'

type Item =
  | { kind: 'note'; note: Note }
  | { kind: 'create'; name: string }
  | { kind: 'workspace'; ws: WorkspaceInfo }
  | { kind: 'new-workspace' }

/** 命令：输入的文字与命令名模糊匹配时列出（输入为空时不显示，列表和原来一样只有笔记）。 */
const SWITCH_LABEL = '切换工作空间'
const NEW_WS_LABEL = '新建工作空间'

function commandItems(q: string, list: WorkspaceInfo[], current: string): Item[] {
  // 一个字太容易模糊匹配上（比如搜“新”），至少两个字才列出命令
  if ([...q.replace(/\s+/g, '')].length < 2) return []
  const out: { item: Item; s: number }[] = []
  for (const ws of list) {
    if (ws.id === current) continue
    // “切换工作空间”列出全部其他工作空间，也可以直接输入工作空间名
    const s = Math.max(fuzzyScore(q, SWITCH_LABEL), fuzzyScore(q, `${SWITCH_LABEL}${ws.name}`), fuzzyScore(q, ws.name))
    if (s >= 0) out.push({ item: { kind: 'workspace', ws }, s })
  }
  const s = fuzzyScore(q, NEW_WS_LABEL)
  if (s >= 0) out.push({ item: { kind: 'new-workspace' }, s: s - 1 })
  return out.sort((a, b) => b.s - a.s).map((x) => x.item)
}

const itemKey = (item: Item) =>
  item.kind === 'note' ? item.note.id : item.kind === 'workspace' ? `ws:${item.ws.id}` : item.kind

/** Ctrl/Cmd+K：按名称快速打开笔记，没有匹配时可直接新建；也是命令面板（切换、新建工作空间）。 */
export function QuickSwitcher() {
  const open = useUI((s) => s.switcherOpen)
  const setOpen = useUI((s) => s.setSwitcherOpen)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="switcher-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <SwitcherBody onClose={() => setOpen(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function SwitcherBody({ onClose }: { onClose: () => void }) {
  const notes = useVault((s) => s.notes)
  const workspaces = useWorkspace((s) => s.list)
  const currentWs = useWorkspace((s) => s.current)
  const pop = usePop({ scale: 0.97, y: -8 }, { scale: 0.98, y: -4 })
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const all = Object.values(notes)
    const q = query.trim()
    if (!q) {
      const recent = recentIds()
        .map((id) => notes[id])
        .filter(Boolean)
      const rest = all.filter((n) => !recent.includes(n)).sort((a, b) => b.mtime - a.mtime)
      return [...recent, ...rest].slice(0, 50).map((note) => ({ kind: 'note', note }))
    }
    const scored = all
      .map((note) => {
        // 标题匹配加权；标题匹配不上（-1）时不能靠加权混进结果
        const t = fuzzyScore(q, note.title)
        return { note, s: Math.max(t < 0 ? -1 : t + 50, fuzzyScore(q, note.path)) }
      })
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || b.note.mtime - a.note.mtime)
      .slice(0, 50)
    const out: Item[] = scored.map(({ note }) => ({ kind: 'note', note }))
    out.push(...commandItems(q, workspaces, currentWs))
    const exact = all.some((n) => n.title.toLowerCase() === q.toLowerCase())
    if (!exact && !invalidNameReason(q)) out.push({ kind: 'create', name: q })
    return out
  }, [notes, query, workspaces, currentWs])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (item: Item | undefined) => {
    if (!item) return
    onClose()
    if (item.kind === 'note') openNote(item.note.id)
    else if (item.kind === 'workspace') switchWorkspace(item.ws.id)
    else if (item.kind === 'new-workspace') void promptCreateWorkspace()
    else void newNote('', item.name)
  }

  return (
    <motion.div
      className="switcher"
      role="dialog"
      aria-modal="true"
      aria-label="快速切换"
      {...pop}
      transition={springSnappy}
    >
      <div className="switcher-input-row">
        <Search size={18} aria-hidden="true" />
        <input
          autoFocus
          className="switcher-input"
          placeholder="输入笔记名称或命令…"
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={items[index] ? `switcher-opt-${index}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(items[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        />
        <kbd className="switcher-kbd">Esc</kbd>
      </div>
      <div className="switcher-list" id="switcher-list" role="listbox" ref={listRef}>
        {!items.length && <p className="switcher-empty">没有匹配的笔记</p>}
        {items.map((item, i) => (
          <div
            key={itemKey(item)}
            id={`switcher-opt-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === index}
            className={`switcher-item${i === index ? ' is-selected' : ''}`}
            onMouseMove={() => i !== index && setIndex(i)}
            onClick={() => choose(item)}
          >
            {item.kind === 'note' ? (
              <>
                <FileText size={16} aria-hidden="true" />
                <span className="switcher-title">{item.note.title}</span>
                <span className="switcher-path">{dirname(item.note.path)}</span>
              </>
            ) : item.kind === 'workspace' ? (
              <>
                <ArrowRightLeft size={16} aria-hidden="true" />
                <span className="switcher-title">{`${SWITCH_LABEL}：${item.ws.name}`}</span>
                <span className="switcher-path">命令</span>
              </>
            ) : item.kind === 'new-workspace' ? (
              <>
                <Plus size={16} aria-hidden="true" />
                <span className="switcher-title">{`${NEW_WS_LABEL}…`}</span>
                <span className="switcher-path">命令</span>
              </>
            ) : (
              <>
                <FilePlus size={16} aria-hidden="true" />
                <span className="switcher-title">新建笔记“{item.name}”</span>
              </>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  )
}

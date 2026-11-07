import { FilePlus, FileText, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../api/types'
import { dirname, invalidNameReason } from '../../lib/paths'
import { fuzzyScore } from '../../lib/snippet'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { fadeTransition, springSnappy } from '../../styles/tokens/motion'
import { newNote, openNote, recentIds } from '../actions'
import './switcher.css'

type Item = { kind: 'note'; note: Note } | { kind: 'create'; name: string }

/** Ctrl/Cmd+K：按名称快速打开笔记，没有匹配时可直接新建。 */
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
      .map((note) => ({ note, s: Math.max(fuzzyScore(q, note.title) + 50, fuzzyScore(q, note.path)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || b.note.mtime - a.note.mtime)
      .slice(0, 50)
    const out: Item[] = scored.map(({ note }) => ({ kind: 'note', note }))
    const exact = all.some((n) => n.title.toLowerCase() === q.toLowerCase())
    if (!exact && !invalidNameReason(q)) out.push({ kind: 'create', name: q })
    return out
  }, [notes, query])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (item: Item | undefined) => {
    if (!item) return
    onClose()
    if (item.kind === 'note') openNote(item.note.id)
    else void newNote('', item.name)
  }

  return (
    <motion.div
      className="switcher"
      role="dialog"
      aria-modal="true"
      aria-label="快速切换"
      initial={{ opacity: 0, scale: 0.97, y: -8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: -4 }}
      transition={springSnappy}
    >
      <div className="switcher-input-row">
        <Search size={18} aria-hidden="true" />
        <input
          autoFocus
          className="switcher-input"
          placeholder="输入笔记名称…"
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
            key={item.kind === 'note' ? item.note.id : 'create'}
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

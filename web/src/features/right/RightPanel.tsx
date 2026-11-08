import { Hash, Link, ListTree, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { Backlink } from '../../api/types'
import { EmptyState, IconButton, Spinner } from '../../components/ui'
import { dirname } from '../../lib/paths'
import { useEditor } from '../../stores/editor'
import { type RightTab, useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { openNote } from '../actions'
import { revealLine } from '../editor/editorRef'
import { PanelToggleAnchor } from '../shell/PanelToggle'
import './right.css'

const TABS: { id: RightTab; label: string; icon: typeof Link }[] = [
  { id: 'backlinks', label: '反链', icon: Link },
  { id: 'outline', label: '大纲', icon: ListTree },
  { id: 'tags', label: '标签', icon: Hash },
]

function Backlinks({ id }: { id: string }) {
  const version = useVault((s) => s.version)
  const notes = useVault((s) => s.notes)
  const [items, setItems] = useState<Backlink[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .backlinks(id)
      .then((b) => !cancelled && setItems(b))
      .catch(() => !cancelled && setItems([]))
    return () => {
      cancelled = true
    }
    // notes 变化（改名、新建）或其他笔记内容变化都可能影响反链
  }, [id, version, notes])

  if (!items) return <div className="right-loading"><Spinner /></div>
  if (!items.length) return <EmptyState title="没有反链">其他笔记用 [[链接]] 引用这篇笔记时会显示在这里</EmptyState>
  return (
    <ul className="backlinks" aria-label="反向链接">
      {items.map((b) => (
        <li key={b.id}>
          <button className="backlink" onClick={() => openNote(b.id)}>
            <span className="backlink-title">{b.title}</span>
            {dirname(b.path) && <span className="backlink-path">{dirname(b.path)}</span>}
            {b.lines.slice(0, 3).map((l) => (
              <span key={l.line} className="backlink-line">
                {l.text}
              </span>
            ))}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Outline() {
  const headings = useEditor((s) => s.headings)
  if (!headings.length) return <EmptyState title="没有标题">用 # 开头的行会出现在大纲里</EmptyState>
  const min = Math.min(...headings.map((h) => h.level))
  return (
    <ul className="outline" aria-label="大纲">
      {headings.map((h, i) => (
        <li key={`${h.line}-${i}`}>
          <button
            className="outline-item"
            style={{ paddingLeft: `calc(var(--space-3) + ${h.level - min} * 0.9rem)` }}
            onClick={() => revealLine(h.line)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

function NoteTags({ id }: { id: string }) {
  const version = useVault((s) => s.version)
  const rev = useEditor((s) => (s.doc?.id === id ? s.doc.rev : 0))
  const navigate = useUI((s) => s.navigate)
  const [tags, setTags] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .noteTags(id)
      .then((t) => !cancelled && setTags(t))
      .catch(() => !cancelled && setTags([]))
    return () => {
      cancelled = true
    }
  }, [id, version, rev])
  if (!tags) return <div className="right-loading"><Spinner /></div>
  if (!tags.length) return <EmptyState title="没有标签">在正文写 #标签，或在 frontmatter 写 tags</EmptyState>
  return (
    <div className="chips">
      {tags.map((t) => (
        <button key={t} className="chip" onClick={() => navigate({ view: 'tag', tag: t })}>
          #{t}
        </button>
      ))}
    </div>
  )
}

/** 右栏：反链、大纲、标签。助手在笔记页的弹窗里打开（见 agent/AgentPopup），不在右栏。 */
export function RightPanel({ id, onClose }: { id: string | null; onClose?: () => void }) {
  const tab = useUI((s) => s.rightTab)
  const setTab = useUI((s) => s.setRightTab)
  return (
    <aside className="right-panel" aria-label="笔记信息">
      <header className="right-head">
        {/* 桌面端的收起按钮浮在这里，紧贴右栏左缘（见 shell/PanelToggle） */}
        <PanelToggleAnchor side="right" />
        <div className="right-tabs" role="tablist" aria-label="笔记信息">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`right-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="right-body"
              className={`right-tab${tab === t.id ? ' is-selected' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={14} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>
        {onClose && (
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        )}
      </header>
      <div className="right-body" id="right-body" role="tabpanel" aria-labelledby={`right-tab-${tab}`}>
        {!id ? (
          <EmptyState title="未打开笔记" />
        ) : tab === 'backlinks' ? (
          <Backlinks id={id} />
        ) : tab === 'outline' ? (
          <Outline />
        ) : (
          <NoteTags id={id} />
        )}
      </div>
    </aside>
  )
}

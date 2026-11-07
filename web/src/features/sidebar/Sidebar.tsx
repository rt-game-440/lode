import { FilePlus, FolderPlus, Hash, LogOut, Monitor, Moon, PanelLeft, Search, Sun, Trash } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState, IconButton } from '../../components/ui'
import { useSession } from '../../stores/session'
import { type SidebarTab, type Theme, useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { newFolder, newNote } from '../actions'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import './sidebar.css'

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' }
const THEME_ICON: Record<Theme, ReactNode> = {
  system: <Monitor size={17} />,
  light: <Sun size={17} />,
  dark: <Moon size={17} />,
}

function TagList() {
  const tags = useVault((s) => s.tags)
  const route = useUI((s) => s.route)
  const navigate = useUI((s) => s.navigate)
  if (!tags.length) {
    return (
      <EmptyState icon={<Hash size={26} strokeWidth={1.5} />} title="还没有标签">
        在笔记里写 #标签 即可添加
      </EmptyState>
    )
  }
  return (
    <ul className="tag-list" aria-label="标签">
      {tags.map((t) => {
        const depth = t.tag.split('/').length - 1
        const active = route.view === 'tag' && route.tag === t.tag
        return (
          <li key={t.tag}>
            <button
              className={`tag-row${active ? ' is-active' : ''}`}
              style={{ paddingLeft: `calc(var(--space-3) + ${depth} * 0.9rem)` }}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate({ view: 'tag', tag: t.tag })}
            >
              <Hash size={14} aria-hidden="true" />
              <span className="tag-name">{depth ? t.tag.slice(t.tag.lastIndexOf('/') + 1) : t.tag}</span>
              <span className="tag-count">{t.count}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'files', label: '文件' },
  { id: 'search', label: '搜索' },
  { id: 'tags', label: '标签' },
]

export function Sidebar({ mobile }: { mobile?: boolean }) {
  const tab = useUI((s) => s.sidebarTab)
  const setTab = useUI((s) => s.setSidebarTab)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const theme = useUI((s) => s.theme)
  const setTheme = useUI((s) => s.setTheme)
  const route = useUI((s) => s.route)
  const navigate = useUI((s) => s.navigate)
  const logout = useSession((s) => s.logout)

  return (
    <nav className="sidebar" aria-label="侧栏">
      <header className="sidebar-head">
        {!mobile && (
          <IconButton label="隐藏侧栏 (Ctrl+\)" onClick={() => toggleSidebar(false)}>
            <PanelLeft size={18} />
          </IconButton>
        )}
        <span className="sidebar-brand">Lode</span>
        <span className="spacer" />
        <IconButton label="新建文件夹" onClick={() => void newFolder('')}>
          <FolderPlus size={18} />
        </IconButton>
        <IconButton label="新建笔记" onClick={() => void newNote('')} data-testid="new-note">
          <FilePlus size={18} />
        </IconButton>
      </header>

      <div className="segmented" role="tablist" aria-label="侧栏视图">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`sidebar-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="sidebar-panel"
            className={`segment${tab === t.id ? ' is-selected' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.id === 'search' && <Search size={13} aria-hidden="true" />}
            {t.label}
          </button>
        ))}
      </div>

      <div className="sidebar-body" id="sidebar-panel" role="tabpanel" aria-labelledby={`sidebar-tab-${tab}`}>
        {tab === 'files' && <FileTree />}
        {tab === 'search' && <SearchPanel autoFocus />}
        {tab === 'tags' && <TagList />}
      </div>

      <footer className="sidebar-foot">
        <button
          className={`foot-link${route.view === 'trash' ? ' is-active' : ''}`}
          onClick={() => navigate({ view: 'trash' })}
          aria-current={route.view === 'trash' ? 'page' : undefined}
        >
          <Trash size={16} aria-hidden="true" />
          回收站
        </button>
        <span className="spacer" />
        <IconButton label={`主题：${THEME_LABEL[theme]}（点击切换）`} onClick={() => setTheme(THEME_NEXT[theme])}>
          {THEME_ICON[theme]}
        </IconButton>
        <IconButton label="退出登录" onClick={() => void logout()}>
          <LogOut size={17} />
        </IconButton>
      </footer>
    </nav>
  )
}

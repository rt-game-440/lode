import { FilePlus, FolderPlus, Hash, LogOut, Monitor, Moon, PanelLeft, Search, Settings, Sparkles, Sun, Trash } from 'lucide-react'
import type { ReactNode } from 'react'
import { confirmDialog } from '../../components/overlays'
import { EmptyState, IconButton } from '../../components/ui'
import { useSession } from '../../stores/session'
import { type SidebarTab, type Theme, useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { useSync } from '../../sync/engine'
import { newFolder, newNote } from '../actions'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import { SyncIndicator } from './SyncIndicator'
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

  // 退出时写队列保留在本机 IndexedDB（clearCache 不动队列），重新登录后由同步引擎重放，所以提示“保留在本机”
  const askLogout = async () => {
    const pending = useSync.getState().pending
    const ok = await confirmDialog({
      title: '退出登录？',
      message: (
        <>
          <p>退出后需要重新输入密码。</p>
          {pending > 0 && (
            <p>
              本机还有 {pending} 项未同步的修改，退出后会保留在本机，重新登录后自动同步。
            </p>
          )}
        </>
      ),
      confirmLabel: '退出登录',
      danger: true,
      initialFocus: 'cancel',
    })
    if (ok) await logout()
  }

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
        <SyncIndicator />
        <button
          className={`foot-link hit-expand${route.view === 'trash' ? ' is-active' : ''}`}
          onClick={() => navigate({ view: 'trash' })}
          aria-current={route.view === 'trash' ? 'page' : undefined}
        >
          <Trash size={16} aria-hidden="true" />
          回收站
        </button>
        <span className="spacer" />
        <IconButton
          label="助手"
          className={route.view === 'agent' ? 'is-active' : undefined}
          aria-current={route.view === 'agent' ? 'page' : undefined}
          onClick={() => useUI.getState().openAgent()}
          data-testid="open-agent"
        >
          <Sparkles size={17} />
        </IconButton>
        <IconButton
          label="设置"
          className={route.view === 'settings' ? 'is-active' : undefined}
          aria-current={route.view === 'settings' ? 'page' : undefined}
          onClick={() => navigate({ view: 'settings' })}
        >
          <Settings size={17} />
        </IconButton>
        <IconButton label={`主题：${THEME_LABEL[theme]}（点击切换）`} onClick={() => setTheme(THEME_NEXT[theme])}>
          {THEME_ICON[theme]}
        </IconButton>
        <IconButton label="退出登录" onClick={() => void askLogout()}>
          <LogOut size={17} />
        </IconButton>
      </footer>
    </nav>
  )
}

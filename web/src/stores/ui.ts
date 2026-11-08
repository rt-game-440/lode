import { create } from 'zustand'

export type Route =
  | { view: 'home' }
  | { view: 'note'; id: string }
  | { view: 'trash' }
  | { view: 'tag'; tag: string }
  /** sub 是设置里的子页面路径，例如 ['tokens', '<id>']；省略或为空表示设置首页 */
  | { view: 'settings'; sub?: string[] }
  | { view: 'agent' }

export type Theme = 'system' | 'light' | 'dark'
export type RightTab = 'backlinks' | 'outline' | 'tags'
const RIGHT_TABS: readonly RightTab[] = ['backlinks', 'outline', 'tags']
export type SidebarTab = 'files' | 'search' | 'tags'

export interface Toast {
  id: number
  message: string
  tone?: 'info' | 'error' | 'success'
  action?: { label: string; run: () => void }
  /** 不自动消失（需要用户处理或手动关闭） */
  persistent?: boolean
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'note' && parts[1]) return { view: 'note', id: parts[1] }
  if (parts[0] === 'trash') return { view: 'trash' }
  if (parts[0] === 'settings') return parts.length > 1 ? { view: 'settings', sub: parts.slice(1) } : { view: 'settings' }
  if (parts[0] === 'agent') return { view: 'agent' }
  if (parts[0] === 'tag' && parts[1]) return { view: 'tag', tag: parts.slice(1).join('/') }
  return { view: 'home' }
}

export function routePath(r: Route): string {
  switch (r.view) {
    case 'note':
      return `/note/${encodeURIComponent(r.id)}`
    case 'trash':
      return '/trash'
    case 'settings':
      return ['/settings', ...(r.sub ?? []).map(encodeURIComponent)].join('/')
    case 'agent':
      return '/agent'
    case 'tag':
      return `/tag/${r.tag.split('/').map(encodeURIComponent).join('/')}`
    default:
      return '/'
  }
}

const THEME_KEY = 'lode.theme'
const LAYOUT_KEY = 'lode.layout'

/** 侧栏宽度范围（px），与 tokens 中的 --sidebar-width 默认值一致。 */
export const SIDEBAR_WIDTH = { min: 200, max: 420, default: 264 } as const

export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_WIDTH.default
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)))
}

interface Layout {
  sidebarOpen: boolean
  sidebarWidth: number
  rightOpen: boolean
  rightTab: RightTab
}

function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    return {
      sidebarOpen: v.sidebarOpen ?? true,
      sidebarWidth: clampSidebarWidth(v.sidebarWidth ?? SIDEBAR_WIDTH.default),
      rightOpen: v.rightOpen ?? true,
      // 旧版本的布局偏好里可能存着已经去掉的“助手”标签
      rightTab: RIGHT_TABS.includes(v.rightTab) ? v.rightTab : 'backlinks',
    }
  } catch {
    return { sidebarOpen: true, sidebarWidth: SIDEBAR_WIDTH.default, rightOpen: true, rightTab: 'backlinks' }
  }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
}

interface UIState {
  route: Route
  navigate: (r: Route, replace?: boolean) => void
  syncFromLocation: () => void

  sidebarOpen: boolean
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
  rightOpen: boolean
  rightTab: RightTab
  sidebarTab: SidebarTab
  toggleSidebar: (open?: boolean) => void
  toggleRight: (open?: boolean) => void
  setRightTab: (t: RightTab) => void
  setSidebarTab: (t: SidebarTab) => void
  /** 打开助手页面（侧栏底部的全局入口；弹窗里的“展开”也走这里）：先关掉笔记页上的助手弹窗 */
  openAgent: () => void

  /** 笔记页上的助手弹窗（桌面是浮在编辑区上的面板，手机是底部半屏面板） */
  agentPopup: boolean
  setAgentPopup: (open: boolean) => void

  /** 手机单栏导航栈当前显示的层 */
  mobilePane: 'list' | 'detail'
  setMobilePane: (p: 'list' | 'detail') => void

  switcherOpen: boolean
  setSwitcherOpen: (open: boolean) => void

  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  theme: Theme
  setTheme: (t: Theme) => void

  toasts: Toast[]
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0

export const useUI = create<UIState>((set, get) => {
  const persistLayout = () => {
    const { sidebarOpen, sidebarWidth, rightOpen, rightTab } = get()
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarOpen, sidebarWidth, rightOpen, rightTab } satisfies Layout))
  }
  const layout = loadLayout()
  const initialRoute = parseRoute(location.pathname)
  return {
    route: initialRoute,
    navigate: (r, replace = false) => {
      const path = routePath(r)
      if (path !== location.pathname) {
        if (replace) history.replaceState(null, '', path)
        else history.pushState(null, '', path)
      }
      set({ route: r, mobilePane: r.view === 'home' ? 'list' : 'detail', ...(r.view === 'note' ? {} : { agentPopup: false }) })
    },
    syncFromLocation: () => {
      const r = parseRoute(location.pathname)
      set({ route: r, mobilePane: r.view === 'home' ? 'list' : 'detail', ...(r.view === 'note' ? {} : { agentPopup: false }) })
    },

    ...layout,
    sidebarTab: 'files',
    toggleSidebar: (open) => {
      set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen }))
      persistLayout()
    },
    setSidebarWidth: (w) => {
      set({ sidebarWidth: clampSidebarWidth(w) })
      persistLayout()
    },
    toggleRight: (open) => {
      set((s) => ({ rightOpen: open ?? !s.rightOpen }))
      persistLayout()
    },
    setRightTab: (t) => {
      set({ rightTab: t, rightOpen: true })
      persistLayout()
    },
    setSidebarTab: (t) => set({ sidebarTab: t, sidebarOpen: true }),
    openAgent: () => get().navigate({ view: 'agent' }),

    agentPopup: false,
    setAgentPopup: (open) => set({ agentPopup: open }),

    mobilePane: initialRoute.view === 'home' ? 'list' : 'detail',
    setMobilePane: (p) => set({ mobilePane: p }),

    switcherOpen: false,
    setSwitcherOpen: (open) => set({ switcherOpen: open }),

    shortcutsOpen: false,
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

    theme: (localStorage.getItem(THEME_KEY) as Theme) || 'system',
    setTheme: (t) => {
      localStorage.setItem(THEME_KEY, t)
      applyTheme(t)
      set({ theme: t })
    },

    toasts: [],
    toast: (t) => {
      const id = ++toastSeq
      set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }))
      if (!t.persistent) setTimeout(() => get().dismissToast(id), t.action ? 6000 : 3500)
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  }
})

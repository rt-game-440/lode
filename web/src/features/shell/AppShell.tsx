import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useSyncExternalStore } from 'react'
import { DialogHost, MenuHost, ToastHost } from '../../components/overlays'
import { useEditor } from '../../stores/editor'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { fadeTransition, springPanel } from '../../styles/tokens/motion'
import { newNote } from '../actions'
import { EditorPane } from '../editor/EditorPane'
import { RightPanel } from '../right/RightPanel'
import { Sidebar } from '../sidebar/Sidebar'
import { QuickSwitcher } from '../switcher/QuickSwitcher'
import { HomeView, TagView, TrashView } from '../views/Views'
import './shell.css'

/** 没有 WebSocket 之前（阶段 2 引入），用轮询 /api/changes 感知外部修改。 */
const POLL_MS = 1000

// 与 tokens 中 --sidebar-width / --rightbar-width 一致
const SIDEBAR_W = 264
const RIGHT_W = 300

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
  )
}

function usePolling() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const tick = async () => {
      timer = null
      if (document.visibilityState === 'visible') {
        try {
          const changes = await useVault.getState().poll()
          const current = useEditor.getState().noteId
          if (current && changes.some((c) => c.id === current)) await useEditor.getState().reload()
          if (changes.length) void useVault.getState().refreshTags()
        } catch {
          /* 网络错误时下次再试 */
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && timer) {
        clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const ui = useUI.getState()
      const key = e.key.toLowerCase()
      if (key === 'k' || (key === 'o' && !e.shiftKey)) {
        e.preventDefault()
        ui.setSwitcherOpen(!ui.switcherOpen)
      } else if (key === '\\') {
        e.preventDefault()
        ui.toggleSidebar()
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault()
        ui.setSidebarTab('search')
        if (window.matchMedia('(max-width: 767px)').matches) ui.navigate({ view: 'home' })
      } else if (key === 'n' && e.altKey) {
        e.preventDefault()
        void newNote('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function MainView({ mobile }: { mobile: boolean }) {
  const route = useUI((s) => s.route)
  switch (route.view) {
    case 'note':
      return <EditorPane id={route.id} mobile={mobile} />
    case 'trash':
      return <TrashView mobile={mobile} />
    case 'tag':
      return <TagView tag={route.tag} mobile={mobile} />
    default:
      return <HomeView />
  }
}

export function AppShell() {
  const load = useVault((s) => s.load)
  const syncFromLocation = useUI((s) => s.syncFromLocation)
  const route = useUI((s) => s.route)
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const rightOpen = useUI((s) => s.rightOpen)
  const toggleRight = useUI((s) => s.toggleRight)
  const mobilePane = useUI((s) => s.mobilePane)
  const mobile = useMedia('(max-width: 767px)')
  const wide = useMedia('(min-width: 1100px)')

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  useEffect(() => {
    window.addEventListener('popstate', syncFromLocation)
    return () => window.removeEventListener('popstate', syncFromLocation)
  }, [syncFromLocation])

  // 窄屏下右栏以浮层显示，默认收起（不写入布局偏好）
  useEffect(() => {
    if (!wide) useUI.setState({ rightOpen: false })
  }, [wide])

  // 离开笔记时关闭编辑器状态
  useEffect(() => {
    if (route.view !== 'note') useEditor.getState().close()
  }, [route])

  usePolling()
  useShortcuts()

  const noteId = route.view === 'note' ? route.id : null
  const showRight = noteId !== null && rightOpen

  const overlays = (
    <>
      <QuickSwitcher />
      <DialogHost />
      <MenuHost />
      <ToastHost />
    </>
  )

  if (mobile) {
    return (
      <div className="shell is-mobile">
        <AnimatePresence initial={false} mode="popLayout">
          {mobilePane === 'list' ? (
            <motion.div
              key="list"
              className="mobile-layer"
              initial={{ x: '-30%', opacity: 0.6 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '-30%', opacity: 0.6 }}
              transition={springPanel}
            >
              <Sidebar mobile />
            </motion.div>
          ) : (
            <motion.div
              key="detail"
              className="mobile-layer is-detail"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={springPanel}
            >
              <MainView mobile />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showRight && mobilePane === 'detail' && (
            <RightSheet onClose={() => toggleRight(false)} id={noteId} />
          )}
        </AnimatePresence>
        {overlays}
      </div>
    )
  }

  return (
    <div className="shell">
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.div
            key="sidebar"
            className="shell-sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: SIDEBAR_W, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={springPanel}
          >
            <div className="shell-sidebar-inner">
              <Sidebar />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <main className="shell-main">
        <MainView mobile={false} />
      </main>
      {wide ? (
        <AnimatePresence initial={false}>
          {showRight && (
            <motion.div
              key="right"
              className="shell-right"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: RIGHT_W, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={springPanel}
            >
              <div className="shell-right-inner">
                <RightPanel id={noteId} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        <AnimatePresence>{showRight && <RightSheet onClose={() => toggleRight(false)} id={noteId} />}</AnimatePresence>
      )}
      {overlays}
    </div>
  )
}

/** 窄屏下的右栏浮层：从右侧滑入，点击空白处关闭。 */
function RightSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <motion.div
        className="sheet-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={fadeTransition}
        onClick={onClose}
      />
      <motion.div
        className="right-sheet"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={springPanel}
      >
        <RightPanel id={id} onClose={onClose} />
      </motion.div>
    </>
  )
}

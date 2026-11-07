import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Drawer } from '../../components/Drawer'
import { DialogHost, MenuHost, ToastHost } from '../../components/overlays'
import { useEditor } from '../../stores/editor'
import { type Route, useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { sync } from '../../sync/engine'
import { errorMessage, newNote } from '../actions'
import { EditorPane } from '../editor/EditorPane'
import { RightPanel } from '../right/RightPanel'
import { Sidebar } from '../sidebar/Sidebar'
import { QuickSwitcher } from '../switcher/QuickSwitcher'
import { SettingsView } from '../settings/SettingsView'
import { HomeView, TagView, TrashView } from '../views/Views'
import { AgentPanel } from '../agent/AgentPanel'
import { ShortcutsDialog, isTypingTarget } from './ShortcutsDialog'
import { MobileStack } from './MobileStack'
import { SidebarResizer } from './SidebarResizer'
import { usePanelMotion } from './panelMotion'
import { springPanel } from '../../styles/tokens/motion'
import './shell.css'

// 与 tokens 中 --rightbar-width 一致
const RIGHT_W = 300
// 右栏显示助手时更宽，与 tokens 中 --rightbar-width-agent 一致
const AGENT_W = 380

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

/** 实时同步：连接 WebSocket、重放离线写队列（替代阶段 1 的轮询）。 */
function useRealtimeSync() {
  useEffect(() => {
    sync.start()
    return () => sync.stop()
  }, [])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState()
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        ui.setShortcutsOpen(!ui.shortcutsOpen)
        return
      }
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
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

function MainView({ mobile, route, contextNoteId }: { mobile: boolean; route: Route; contextNoteId: string | null }) {
  switch (route.view) {
    case 'agent':
      return <AgentPanel page mobile={mobile} contextNoteId={contextNoteId} />
    case 'note':
      return <EditorPane id={route.id} mobile={mobile} />
    case 'trash':
      return <TrashView mobile={mobile} />
    case 'tag':
      return <TagView tag={route.tag} mobile={mobile} />
    case 'settings':
      return <SettingsView mobile={mobile} />
    default:
      return <HomeView />
  }
}

export function AppShell() {
  const load = useVault((s) => s.load)
  const syncFromLocation = useUI((s) => s.syncFromLocation)
  const route = useUI((s) => s.route)
  const rightOpen = useUI((s) => s.rightOpen)
  const rightTab = useUI((s) => s.rightTab)
  const toggleRight = useUI((s) => s.toggleRight)
  const mobilePane = useUI((s) => s.mobilePane)
  const mobile = useMedia('(max-width: 767px)')
  const wide = useMedia('(min-width: 1100px)')

  useEffect(() => {
    const tryLoad = () =>
      load().catch((err) =>
        useUI.getState().toast({
          message: `笔记列表加载失败：${errorMessage(err)}`,
          tone: 'error',
          action: { label: '重试', run: () => void tryLoad() },
        }),
      )
    void tryLoad()
  }, [load])

  useEffect(() => {
    window.addEventListener('popstate', syncFromLocation)
    return () => window.removeEventListener('popstate', syncFromLocation)
  }, [syncFromLocation])

  // 窄屏下右栏以抽屉显示，默认收起（不写入布局偏好）
  useEffect(() => {
    if (!wide) useUI.setState({ rightOpen: false })
  }, [wide])

  // 离开笔记时关闭编辑器状态（手机上等详情页滑出后再关，见 MobileStack）
  useEffect(() => {
    if (route.view !== 'note' && !mobile) useEditor.getState().close()
  }, [route, mobile])

  useRealtimeSync()
  useShortcuts()

  const noteId = route.view === 'note' ? route.id : null
  // 右栏收起动画期间继续显示原来那篇笔记的内容
  const lastNoteId = useRef(noteId)
  if (noteId) lastNoteId.current = noteId
  // 助手不依赖打开的笔记；全屏助手页面上不再在右栏重复显示
  const agentTab = rightTab === 'agent' && !mobile
  const showRight = rightOpen && (agentTab ? route.view !== 'agent' : noteId !== null)
  const closeRight = () => toggleRight(false)

  const overlays = (
    <>
      <QuickSwitcher />
      <ShortcutsDialog />
      <DialogHost />
      <MenuHost />
      <ToastHost />
    </>
  )

  if (mobile) {
    return (
      <div className="shell is-mobile">
        <MobileStack list={<Sidebar mobile />} detail={(r) => <MainView mobile route={r} contextNoteId={lastNoteId.current} />} />
        <Drawer open={showRight && mobilePane === 'detail' && route.view === 'note'} onClose={closeRight} label="笔记信息">
          <RightPanel id={lastNoteId.current} onClose={closeRight} allowAgent={false} />
        </Drawer>
        {overlays}
      </div>
    )
  }

  return (
    <>
      <DesktopShell route={route} rightInline={wide && showRight} rightId={lastNoteId.current} />
      {!wide && (
        <Drawer open={showRight} onClose={closeRight} label="笔记信息">
          <RightPanel id={lastNoteId.current} onClose={closeRight} />
        </Drawer>
      )}
      {overlays}
    </>
  )
}

/**
 * 桌面三栏：侧栏、主区域、右栏。展开收起和调宽只改 transform（见 usePanelMotion），
 * 主区域的宽度只在动画开始或结束时变化一次。
 */
function DesktopShell({ route, rightInline, rightId }: { route: Route; rightInline: boolean; rightId: string | null }) {
  const rightTab = useUI((s) => s.rightTab)
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const storedWidth = useUI((s) => s.sidebarWidth)
  const sbW = useMotionValue(storedWidth)
  // 先于 usePanelMotion 同步宽度：展开时按保存的宽度动画
  useEffect(() => {
    if (sidebarOpen) sbW.set(storedWidth)
  }, [sidebarOpen, storedWidth, sbW])
  const left = usePanelMotion(sidebarOpen, sbW)
  const rTarget = rightTab === 'agent' ? AGENT_W : RIGHT_W
  const rW = useMotionValue(rTarget)
  const reduced = useReducedMotion()
  // 切换到助手时右栏加宽：宽度用弹簧过渡，主区域随之让出空间
  useEffect(() => {
    if (!rightInline || reduced) {
      rW.set(rTarget)
      return
    }
    const c = animate(rW, rTarget, springPanel)
    return () => c.stop()
  }, [rTarget, rightInline, reduced, rW])
  const right = usePanelMotion(rightInline, rW)

  const sbX = useTransform(() => left.offset.get() - sbW.get())
  const mainLeft = useTransform(() => left.reserved.get() * sbW.get())
  const mainX = useTransform(() => left.offset.get() - left.reserved.get() * sbW.get())
  const mainWidth = useTransform(
    () => `calc(100% - ${left.reserved.get() * sbW.get() + right.reserved.get() * rW.get()}px)`,
  )
  const rightX = useTransform(() => rW.get() - right.offset.get())
  const resizerX = useTransform(() => left.offset.get())

  return (
    <div className="shell">
      <motion.div
        className="shell-sidebar"
        style={{ x: sbX, width: sbW, visibility: left.visible ? 'visible' : 'hidden' }}
        inert={!sidebarOpen}
        data-testid="shell-sidebar"
      >
        <Sidebar />
      </motion.div>
      {sidebarOpen && left.visible && <SidebarResizer width={sbW} x={resizerX} />}
      <motion.main className="shell-main" style={{ left: mainLeft, x: mainX, width: mainWidth }}>
        <MainView mobile={false} route={route} contextNoteId={rightId} />
      </motion.main>
      <motion.div
        className="shell-right"
        style={{ x: rightX, width: rW, visibility: right.visible ? 'visible' : 'hidden' }}
        inert={!rightInline}
      >
        {right.visible && <RightPanel id={rightId} />}
      </motion.div>
    </div>
  )
}

import { PanelLeft, PanelRight } from 'lucide-react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
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
import { PanelEdgesContext, usePanelMotion } from './panelMotion'
import { PanelToggle, PanelToggleProvider, usePanelToggle } from './PanelToggle'
import { springPanel } from '../../styles/tokens/motion'
import './shell.css'

// 与 tokens 中 --rightbar-width 一致
const RIGHT_W = 300
// 右栏显示助手时更宽，与 tokens 中 --rightbar-width-agent 一致
const AGENT_W = 380
/** 手机笔记页的编辑区：右缘左滑拉出右侧栏的起手区域（touch-action 见 shell.css） */
const MOBILE_NOTE_ZONE = '.mobile-layer.is-detail .editor-scroll'

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
    const noteDetail = mobilePane === 'detail' && route.view === 'note'
    return (
      <div className="shell is-mobile">
        <MobileStack list={<Sidebar mobile />} detail={(r) => <MainView mobile route={r} contextNoteId={lastNoteId.current} />} />
        <Drawer
          open={showRight && noteDetail}
          onClose={closeRight}
          label="笔记信息"
          // 笔记页从屏幕右缘向左滑拉出右侧栏，起手区是编辑区（顶栏、底部工具栏不算）
          edgeSwipe={noteDetail ? { zone: MOBILE_NOTE_ZONE, onOpen: () => toggleRight(true) } : undefined}
        >
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
 * 桌面三栏：侧栏、主区域、右栏。侧栏和右栏的展开收起只改 transform（见 usePanelMotion）；
 * 主区域的左右边缘逐帧贴住两侧面板的边缘，所以标题栏按钮始终可见、正文居中列连续移动，
 * 不会在动画开始或结束时一次性跳变。主区域本身不加 transform（CodeMirror 的 fixed 提示框按视口定位）。
 */
function DesktopShell({ route, rightInline, rightId }: { route: Route; rightInline: boolean; rightId: string | null }) {
  const rightTab = useUI((s) => s.rightTab)
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const storedWidth = useUI((s) => s.sidebarWidth)
  const sbW = useMotionValue(storedWidth)
  const reduced = useReducedMotion()
  const left = usePanelMotion(sidebarOpen, sbW)
  // 展开时恢复保存的宽度（拖过最小宽度收起时，收起动画用的是拖拽中的宽度）。
  // 调宽手柄松手回弹时宽度正在动画，不要打断它；收起途中反向展开时宽度也用弹簧过渡，边缘不跳。
  useEffect(() => {
    if (!sidebarOpen || sbW.isAnimating() || sbW.get() === storedWidth) return
    if (left.progress.get() > 0 && !reduced) {
      const c = animate(sbW, storedWidth, springPanel)
      return () => c.stop()
    }
    sbW.set(storedWidth)
  }, [sidebarOpen, storedWidth, sbW, left.progress, reduced])
  const rTarget = rightTab === 'agent' ? AGENT_W : RIGHT_W
  const rW = useMotionValue(rTarget)
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

  const sbX = useTransform(() => left.edge.get() - sbW.get())
  const rightX = useTransform(() => rW.get() - right.edge.get())
  const edges = useMemo(() => ({ left: left.edge, right: right.edge }), [left.edge, right.edge])

  // 收起按钮沿面板边缘移动，收起后停在编辑区标题栏同侧的角上（#19）。右栏按钮只在笔记页出现
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const rightOpen = useUI((s) => s.rightOpen)
  const toggleRight = useUI((s) => s.toggleRight)
  const leftToggle = usePanelToggle('left', left.edge, sidebarOpen)
  const rightToggle = usePanelToggle('right', right.edge, rightInline)
  const hasRightToggle = route.view === 'note'
  const toggles = useMemo(
    () => ({ cover: { left: leftToggle.cover, right: rightToggle.cover }, right: hasRightToggle }),
    [leftToggle.cover, rightToggle.cover, hasRightToggle],
  )

  return (
    <PanelEdgesContext.Provider value={edges}>
      <PanelToggleProvider value={toggles}>
        <div className="shell">
          <motion.div
            className="shell-sidebar"
            style={{ x: sbX, width: sbW, visibility: left.visible ? 'visible' : 'hidden' }}
            inert={!sidebarOpen}
            data-testid="shell-sidebar"
          >
            <Sidebar />
          </motion.div>
          {sidebarOpen && left.visible && <SidebarResizer width={sbW} x={left.edge} />}
          {/* 放在侧栏和主区域之间：Tab 顺序上紧挨编辑区标题栏之前 */}
          <PanelToggle
            toggle={leftToggle}
            label={sidebarOpen ? '隐藏侧栏 (Ctrl+\\)' : '显示侧栏 (Ctrl+\\)'}
            onClick={() => toggleSidebar()}
          >
            <PanelLeft size={18} />
          </PanelToggle>
          <motion.main className="shell-main" style={{ left: left.edge, right: right.edge }}>
            <MainView mobile={false} route={route} contextNoteId={rightId} />
          </motion.main>
          {/* 放在主区域和右栏之间：Tab 顺序上紧挨右栏标签之前 */}
          {hasRightToggle && (
            <PanelToggle toggle={rightToggle} label={rightOpen ? '隐藏右栏' : '显示右栏'} onClick={() => toggleRight()}>
              <PanelRight size={18} />
            </PanelToggle>
          )}
          <motion.div
            className="shell-right"
            style={{ x: rightX, width: rW, visibility: right.visible ? 'visible' : 'hidden' }}
            inert={!rightInline}
          >
            {right.visible && <RightPanel id={rightId} />}
          </motion.div>
        </div>
      </PanelToggleProvider>
    </PanelEdgesContext.Provider>
  )
}

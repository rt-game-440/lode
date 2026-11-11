import { ChevronRight, FilePlus, FileText, Folder, FolderPlus, Pencil, Trash } from 'lucide-react'
import {
  Fragment,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Note } from '../../api/types'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { EmptyState } from '../../components/ui'
import { dirname } from '../../lib/paths'
import { WORKSPACE_STORAGE, storageKey } from '../../lib/workspace'
import { type TreeNode, type VisibleRow, buildTree, visibleRows } from '../../lib/tree'
import { flushSync } from 'react-dom'
import { type VirtualWindow, scrollToShow, virtualWindow } from '../../lib/virtual'
import { ListItem, ListPresence } from '../../components/AnimatedList'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { useWorkspace } from '../../stores/workspace'
import {
  deleteFolder,
  deleteNote,
  moveFolderTo,
  moveNoteTo,
  newFolder,
  newNote,
  openNote,
  promptRenameFolder,
  promptRenameNote,
} from '../actions'
import { importEntries } from '../import/pick'

const DRAG_TYPE = 'application/x-lode-item'

/** 展开的文件夹按工作空间记住：默认工作空间沿用 `lode.expanded`，其他加 `:<id>`。 */
function loadExpanded(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'))
  } catch {
    return new Set()
  }
}

type DragItem = { kind: 'note'; id: string } | { kind: 'folder'; path: string }

/** 文件树：文件夹在前，支持键盘导航、右键菜单和拖放移动。切换工作空间时整个重新挂载（展开状态各自记住）。 */
export function FileTree() {
  const ws = useWorkspace((s) => s.current)
  return <WorkspaceTree key={ws} expandedKey={storageKey(WORKSPACE_STORAGE.expanded, ws)} />
}

function WorkspaceTree({ expandedKey }: { expandedKey: string }) {
  const folders = useVault((s) => s.folders)
  const notes = useVault((s) => s.notes)
  const loaded = useVault((s) => s.loaded)
  const route = useUI((s) => s.route)
  const activeId = route.view === 'note' ? route.id : null
  const [expanded, setExpanded] = useState(() => loadExpanded(expandedKey))
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const root = useMemo(() => buildTree(folders, Object.values(notes)), [folders, notes])
  const activePath = activeId ? notes[activeId]?.path : undefined

  // 打开的笔记所在目录自动展开
  useEffect(() => {
    if (!activePath) return
    const dirs: string[] = []
    let d = dirname(activePath)
    while (d) {
      dirs.push(d)
      d = dirname(d)
    }
    if (dirs.every((x) => expanded.has(x))) return
    setExpanded((prev) => new Set([...prev, ...dirs]))
  }, [activePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(expandedKey, JSON.stringify([...expanded]))
  }, [expanded, expandedKey])

  const rows = useMemo(() => visibleRows(root, expanded), [root, expanded])

  const toggle = useCallback((path: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const want = open ?? !next.has(path)
      if (want) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const virtual = useVirtualRows(listRef, rows.length, rows.length > VIRTUAL_THRESHOLD)

  const focusRow = (path: string) => {
    setFocusPath(path)
    // 虚拟滚动时目标行可能还没渲染：先滚过去并同步渲染，再立即聚焦。
    // 不能等下一帧：连按方向键时，下一次按键会从旧的焦点行出发。
    virtual.ensureVisible(rows.findIndex((r) => r.node.path === path))
    const find = () => listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    const el = find()
    if (el) el.focus()
    else requestAnimationFrame(() => find()?.focus())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (!target) return
    const i = rows.findIndex((r) => r.node.path === target.dataset.path)
    if (i < 0) return
    const row = rows[i]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (rows[i + 1]) focusRow(rows[i + 1].node.path)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (rows[i - 1]) focusRow(rows[i - 1].node.path)
        break
      case 'ArrowRight':
        if (row.node.kind === 'folder') {
          e.preventDefault()
          if (!expanded.has(row.node.path)) toggle(row.node.path, true)
          else if (rows[i + 1]?.depth > row.depth) focusRow(rows[i + 1].node.path)
        }
        break
      case 'ArrowLeft': {
        e.preventDefault()
        if (row.node.kind === 'folder' && expanded.has(row.node.path)) toggle(row.node.path, false)
        else {
          const parent = dirname(row.node.path)
          if (parent) focusRow(parent)
        }
        break
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (row.node.kind === 'folder') toggle(row.node.path)
        else openNote(row.node.note.id)
        break
      case 'F2':
        e.preventDefault()
        if (row.node.kind === 'folder') void promptRenameFolder(row.node.path)
        else void promptRenameNote(row.node.note)
        break
      case 'Delete':
        e.preventDefault()
        if (row.node.kind === 'folder') void deleteFolder(row.node.path)
        else void deleteNote(row.node.note)
        break
    }
  }

  const drop = (e: DragEvent, dir: string) => {
    e.preventDefault()
    setDropTarget(null)
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    const item = JSON.parse(raw) as DragItem
    if (item.kind === 'note') {
      const n = useVault.getState().notes[item.id]
      if (n) void moveNoteTo(n, dir)
    } else {
      void moveFolderTo(item.path, dir)
    }
    if (dir) toggle(dir, true)
  }

  const allowDrop = (e: DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== dir) setDropTarget(dir)
  }

  if (!loaded) return <div className="tree-loading" aria-busy="true" />

  if (!rows.length) {
    return (
      <EmptyState icon={<FileText size={28} strokeWidth={1.5} />} title="还没有笔记">
        点击上方的 + 新建第一篇笔记
      </EmptyState>
    )
  }

  const win = virtual.window ?? { start: 0, end: rows.length, padTop: 0, padBottom: 0 }
  const shown = rows.slice(win.start, win.end)
  let tabStop = focusPath && rows.some((r) => r.node.path === focusPath) ? focusPath : (activePath ?? rows[0].node.path)
  // Tab 进入树时必须有一行可聚焦：首选行不在渲染范围内就退到第一条渲染的行
  if (!shown.some((r) => r.node.path === tabStop)) tabStop = shown[0]?.node.path ?? tabStop
  // 行数不多时增删带动画（展开文件夹时子项淡入、下方各行平移）；行很多时布局测量太贵，直接切换
  const animateList = rows.length <= LIST_ANIMATE_MAX
  const renderRow = (r: VisibleRow) => (
    <Row
      row={r}
      expanded={r.node.kind === 'folder' && expanded.has(r.node.path)}
      active={r.node.kind === 'note' && r.node.note.id === activeId}
      tabbable={r.node.path === tabStop}
      dropping={r.node.kind === 'folder' && dropTarget === r.node.path}
      onToggle={toggle}
      onFocusPath={setFocusPath}
      onDragOverFolder={allowDrop}
      onDropFolder={drop}
    />
  )

  return (
    <div
      ref={listRef}
      className={`tree${dropTarget === '' ? ' is-drop-root' : ''}`}
      role="tree"
      aria-label="笔记"
      onKeyDown={onKeyDown}
      onDragOver={(e) => allowDrop(e, '')}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null)
      }}
      onDrop={(e) => drop(e, '')}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-path]')) return
        e.preventDefault()
        openMenu({ x: e.clientX, y: e.clientY }, [
          { label: '新建笔记', icon: <FilePlus size={16} />, run: () => void newNote('') },
          { label: '新建文件夹', icon: <FolderPlus size={16} />, run: () => void newFolder('') },
          ...importEntries(''),
        ])
      }}
    >
      {win.padTop > 0 && <div aria-hidden="true" style={{ height: win.padTop }} />}
      {animateList ? (
        <ListPresence>
          {shown.map((r) => (
            <ListItem as="div" role="none" key={r.node.path}>
              {renderRow(r)}
            </ListItem>
          ))}
        </ListPresence>
      ) : (
        shown.map((r) => <Fragment key={r.node.path}>{renderRow(r)}</Fragment>)
      )}
      {win.padBottom > 0 && <div aria-hidden="true" style={{ height: win.padBottom }} />}
    </div>
  )
}

/** 超过这个行数时启用虚拟滚动 */
const VIRTUAL_THRESHOLD = 2000
const OVERSCAN = 12
/** 不超过这个行数时启用增删动画 */
const LIST_ANIMATE_MAX = 300

/**
 * 文件树的虚拟滚动：滚动容器是树的父元素（.sidebar-body），行高取自 --row-height（各行等高）。
 * 未启用时 window 为 null，渲染全部行。
 */
function useVirtualRows(listRef: RefObject<HTMLDivElement | null>, count: number, enabled: boolean) {
  const [win, setWin] = useState<VirtualWindow | null>(null)
  const measure = useRef<() => void>(() => {})
  const rowHeight = useRef(0)

  useLayoutEffect(() => {
    const tree = listRef.current
    const scroller = tree?.parentElement
    if (!enabled || !tree || !scroller) {
      setWin(null)
      measure.current = () => {}
      return
    }
    rowHeight.current = rowHeightOf(tree)
    const update = () => {
      const top = treeTop(tree, scroller)
      const next = virtualWindow({
        count,
        rowHeight: rowHeight.current,
        scrollTop: scroller.scrollTop - top,
        viewport: scroller.clientHeight,
        overscan: OVERSCAN,
      })
      setWin((prev) => (prev && prev.start === next.start && prev.end === next.end && prev.padBottom === next.padBottom ? prev : next))
    }
    measure.current = update
    let frame = 0
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), update()))
    }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    // 尺寸变化（含 pointer: coarse 下行高改变、字号缩放）时重新读取行高
    const ro = new ResizeObserver(() => {
      rowHeight.current = rowHeightOf(tree)
      onScroll()
    })
    ro.observe(scroller)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [listRef, count, enabled])

  const ensureVisible = (index: number) => {
    const tree = listRef.current
    const scroller = tree?.parentElement
    if (!enabled || index < 0 || !tree || !scroller) return
    const top = treeTop(tree, scroller)
    const to = scrollToShow({ index, rowHeight: rowHeight.current, scrollTop: scroller.scrollTop - top, viewport: scroller.clientHeight })
    if (to === null) return
    scroller.scrollTop = to + top
    flushSync(() => measure.current())
  }

  return { window: win, ensureVisible }
}

/** 树顶部在滚动内容中的偏移（树上方还有其他内容时不为 0） */
function treeTop(tree: HTMLElement, scroller: HTMLElement): number {
  return tree.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

function rowHeightOf(el: HTMLElement): number {
  const v = getComputedStyle(el).getPropertyValue('--row-height').trim()
  const px = v.endsWith('rem') ? parseFloat(v) * parseFloat(getComputedStyle(document.documentElement).fontSize) : parseFloat(v)
  return px > 0 ? px : 30
}

interface RowProps {
  row: VisibleRow
  expanded: boolean
  active: boolean
  tabbable: boolean
  dropping: boolean
  onToggle: (path: string, open?: boolean) => void
  onFocusPath: (path: string) => void
  onDragOverFolder: (e: DragEvent, dir: string) => void
  onDropFolder: (e: DragEvent, dir: string) => void
}

function menuFor(node: TreeNode): MenuEntry[] {
  if (node.kind === 'folder') {
    return [
      { label: '新建笔记', icon: <FilePlus size={16} />, run: () => void newNote(node.path) },
      { label: '新建文件夹', icon: <FolderPlus size={16} />, run: () => void newFolder(node.path) },
      ...importEntries(node.path),
      'separator',
      { label: '重命名', icon: <Pencil size={16} />, run: () => void promptRenameFolder(node.path) },
      { label: '删除文件夹', icon: <Trash size={16} />, danger: true, run: () => void deleteFolder(node.path) },
    ]
  }
  const note: Note = node.note
  return [
    { label: '重命名', icon: <Pencil size={16} />, run: () => void promptRenameNote(note) },
    { label: '移到回收站', icon: <Trash size={16} />, danger: true, run: () => void deleteNote(note) },
  ]
}

const Row = memo(function Row({
  row,
  expanded,
  active,
  tabbable,
  dropping,
  onToggle,
  onFocusPath,
  onDragOverFolder,
  onDropFolder,
}: RowProps) {
  const { node, depth } = row
  const isFolder = node.kind === 'folder'
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return
    if (isFolder) onToggle(node.path)
    else openNote(node.note.id)
  }

  const showMenu = (x: number, y: number) => openMenu({ x, y }, menuFor(node))

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={active}
      aria-current={active ? 'page' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-path={node.path}
      className={`tree-row${active ? ' is-active' : ''}${dropping ? ' is-drop' : ''}`}
      style={{ paddingLeft: `calc(var(--space-2) + ${depth} * 1rem)` }}
      draggable
      onFocus={() => onFocusPath(node.path)}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        showMenu(e.clientX, e.clientY)
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return
        const { clientX, clientY } = e
        longPress.current = setTimeout(() => showMenu(clientX, clientY), 500)
      }}
      onPointerUp={() => longPress.current && clearTimeout(longPress.current)}
      onPointerCancel={() => longPress.current && clearTimeout(longPress.current)}
      onPointerMove={() => longPress.current && clearTimeout(longPress.current)}
      onDragStart={(e) => {
        const item: DragItem = isFolder ? { kind: 'folder', path: node.path } : { kind: 'note', id: node.note.id }
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
        e.dataTransfer.setData('text/plain', node.path)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.stopPropagation()
        onDragOverFolder(e, isFolder ? node.path : dirname(node.path))
      }}
      onDrop={(e) => {
        e.stopPropagation()
        onDropFolder(e, isFolder ? node.path : dirname(node.path))
      }}
    >
      <span className={`tree-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">
        {isFolder && <ChevronRight size={14} strokeWidth={2.2} />}
      </span>
      <span className="tree-icon" aria-hidden="true">
        {isFolder ? <Folder size={16} /> : <FileText size={16} />}
      </span>
      <span className="tree-name">{node.name}</span>
    </div>
  )
})

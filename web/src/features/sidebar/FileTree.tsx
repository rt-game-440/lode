import { ChevronRight, FilePlus, FileText, Folder, FolderPlus, Pencil, Trash } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, type MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../api/types'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { EmptyState } from '../../components/ui'
import { dirname } from '../../lib/paths'
import { type TreeNode, type VisibleRow, buildTree, visibleRows } from '../../lib/tree'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
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

const EXPANDED_KEY = 'lode.expanded'
const DRAG_TYPE = 'application/x-lode-item'

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

type DragItem = { kind: 'note'; id: string } | { kind: 'folder'; path: string }

/** 文件树：文件夹在前，支持键盘导航、右键菜单和拖放移动。 */
export function FileTree() {
  const folders = useVault((s) => s.folders)
  const notes = useVault((s) => s.notes)
  const loaded = useVault((s) => s.loaded)
  const route = useUI((s) => s.route)
  const activeId = route.view === 'note' ? route.id : null
  const [expanded, setExpanded] = useState(loadExpanded)
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
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]))
  }, [expanded])

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

  const focusRow = (path: string) => {
    setFocusPath(path)
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
    })
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

  const tabStop = focusPath && rows.some((r) => r.node.path === focusPath) ? focusPath : (activePath ?? rows[0].node.path)

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
        ])
      }}
    >
      {rows.map((r) => (
        <Row
          key={r.node.path}
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
      ))}
    </div>
  )
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

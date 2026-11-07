import type { Note } from '../api/types'
import { basename } from './paths'

export interface FolderNode {
  kind: 'folder'
  path: string
  name: string
  children: TreeNode[]
}

export interface NoteNode {
  kind: 'note'
  path: string
  name: string
  note: Note
}

export type TreeNode = FolderNode | NoteNode

const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' })

/** 把扁平的文件夹与笔记列表组装成树：文件夹在前，各自按名称自然排序。 */
export function buildTree(folders: string[], notes: Note[]): FolderNode {
  const root: FolderNode = { kind: 'folder', path: '', name: '', children: [] }
  const byPath = new Map<string, FolderNode>([['', root]])

  const ensure = (path: string): FolderNode => {
    const existing = byPath.get(path)
    if (existing) return existing
    const i = path.lastIndexOf('/')
    const parent = ensure(i < 0 ? '' : path.slice(0, i))
    const node: FolderNode = { kind: 'folder', path, name: basename(path), children: [] }
    parent.children.push(node)
    byPath.set(path, node)
    return node
  }

  for (const f of folders) ensure(f)
  for (const n of notes) {
    const i = n.path.lastIndexOf('/')
    const parent = ensure(i < 0 ? '' : n.path.slice(0, i))
    parent.children.push({ kind: 'note', path: n.path, name: n.title, note: n })
  }

  const sort = (node: FolderNode) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return collator.compare(a.name, b.name)
    })
    for (const c of node.children) if (c.kind === 'folder') sort(c)
  }
  sort(root)
  return root
}

/** 展开状态下可见的行（用于键盘导航与虚拟滚动）。 */
export interface VisibleRow {
  node: TreeNode
  depth: number
  /** 在同级中的位置（从 1 开始）和同级总数：虚拟滚动只渲染一部分行时，读屏靠它们知道真实位置 */
  posInSet: number
  setSize: number
}

export function visibleRows(root: FolderNode, expanded: Set<string>): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (node: FolderNode, depth: number) => {
    node.children.forEach((c, i) => {
      out.push({ node: c, depth, posInSet: i + 1, setSize: node.children.length })
      if (c.kind === 'folder' && expanded.has(c.path)) walk(c, depth + 1)
    })
  }
  walk(root, 0)
  return out
}

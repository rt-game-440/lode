// 跨工作空间移动、复制（#72）的纯函数：选中条目整理、结果提示文案。
import type { Note, TransferItem, TransferRename, TransferResult } from '../../api/types'

/** 文件树里选中的一项：文件夹按路径，笔记带 id。 */
export type SelectedEntry = { kind: 'folder'; path: string } | { kind: 'note'; path: string; id: string }

/**
 * 把选中的条目整理成请求里的 items：去掉重复项和已被选中文件夹包含的条目（服务端也会去重，这里让计数和确认提示准确），
 * 顺序按路径排序。
 */
export function normalizeSelection(entries: SelectedEntry[]): TransferItem[] {
  const folders = entries.filter((e) => e.kind === 'folder').map((e) => e.path)
  const inside = (p: string) => folders.some((f) => f !== p && p.startsWith(f + '/'))
  const seen = new Set<string>()
  const out: { path: string; item: TransferItem }[] = []
  for (const e of entries) {
    const key = `${e.kind}:${e.path}`
    if (seen.has(key) || inside(e.path)) continue
    seen.add(key)
    out.push({ path: e.path, item: e.kind === 'folder' ? { kind: 'folder', path: e.path } : { kind: 'note', id: e.id } })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((x) => x.item)
}

/** 条目会带走的笔记（文件夹里的全部笔记）：用来判断打开的笔记是否被移走。 */
export function affectedNotes(items: TransferItem[], notes: Record<string, Note>): Set<string> {
  const ids = new Set<string>()
  const all = Object.values(notes)
  for (const it of items) {
    if (it.kind === 'note') ids.add(it.id)
    else for (const n of all) if (n.path.startsWith(it.path + '/')) ids.add(n.id)
  }
  return ids
}

/** 条目的简短描述：“笔记“a”” / “文件夹“资料”” / “3 项”。 */
export function describeItems(items: TransferItem[], notes: Record<string, Note>): string {
  if (items.length !== 1) return `${items.length} 项`
  const it = items[0]
  if (it.kind === 'folder') return `文件夹“${baseName(it.path)}”`
  return `笔记“${notes[it.id]?.title ?? '未命名'}”`
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/** 一项改名：“a.md → a 1.md”（只显示文件名部分，附件显示完整路径）。 */
export function renameLabel(r: TransferRename): string {
  if (r.kind === 'attachment') return `${r.from} → ${r.to}`
  const strip = (p: string) => (r.kind === 'note' ? baseName(p).replace(/\.md$/i, '') : baseName(p))
  return `${strip(r.from)} → ${strip(r.to)}`
}

/** 完成提示：“已复制到“工作”” + 改名的条目（最多列 3 个，其余写“等 N 项”）。 */
export function resultMessage(res: TransferResult, targetName: string, limit = 3): string {
  const verb = res.mode === 'move' ? '移动' : '复制'
  let msg = `已${verb}到“${targetName}”`
  const n = res.renamed.length
  if (n) {
    const shown = res.renamed.slice(0, limit).map(renameLabel).join('，')
    msg += `；重名已自动改名：${shown}${n > limit ? ` 等 ${n} 项` : ''}`
  }
  return msg
}

/** 移动确认里的链接提示；没有会失效的链接时为空。 */
export function brokenLinksWarning(n: number): string {
  return n > 0 ? `其他笔记里指向它的 ${n} 个链接会失效。` : ''
}

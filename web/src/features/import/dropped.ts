// 拖入的文件 / 文件夹 → 导入条目。DataTransfer 在事件结束后失效，所以条目要在 drop 同步阶段取出。
import type { ImportEntry } from './plan'

/** 最小化的 FileSystemEntry，便于单测用假对象。 */
export interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (es: FsEntry[]) => void, err: (e: unknown) => void) => void }
}

export type DroppedEntry = ImportEntry & { file: File }

/** 拖拽里有文件（而不是应用内部的文本 / 笔记拖动）。 */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files')
}

/**
 * dragover 阶段的判断：此时读不到文件名，.md 的 MIME 常为空，
 * 所以只排除“全是图片”的拖拽（交给编辑器上传附件），其余先显示导入提示。
 */
export function looksImportable(dt: DataTransfer | null): boolean {
  if (!hasFiles(dt)) return false
  const items = Array.from(dt!.items ?? []).filter((i) => i.kind === 'file')
  if (!items.length) return true
  return items.some((i) => !i.type.startsWith('image/'))
}

/** drop 阶段的精确判断：有文件夹，或有 .md/.markdown/.txt 文件。 */
export function hasImportableDrop(entries: FsEntry[] | null, files: File[]): boolean {
  if (entries?.some((e) => e.isDirectory)) return true
  return files.some((f) => /\.(md|markdown|txt)$/i.test(f.name))
}

/** 同步取出顶层条目（必须在事件处理函数里直接调用）。 */
export function topEntries(dt: DataTransfer): { entries: FsEntry[] | null; files: File[] } {
  const files = Array.from(dt.files ?? [])
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file')
  const getAs = (items[0] as unknown as { webkitGetAsEntry?: () => FsEntry | null } | undefined)?.webkitGetAsEntry
  if (!items.length || !getAs) return { entries: null, files }
  const entries = items
    .map((i) => (i as unknown as { webkitGetAsEntry: () => FsEntry | null }).webkitGetAsEntry())
    .filter((e): e is FsEntry => !!e)
  // 有的条目取不到 entry（例如脚本构造的 DataTransfer）：整体退回 files，不丢文件
  return { entries: entries.length === items.length ? entries : null, files }
}

const readFile = (e: FsEntry) =>
  new Promise<File>((ok, err) => (e.file ? e.file(ok, err) : err(new Error('no file()'))))

async function readAll(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader?.()
  if (!reader) return []
  const all: FsEntry[] = []
  // readEntries 每次只返回一批（Chromium 约 100 项），读到空数组为止
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err))
    if (!batch.length) return all
    all.push(...batch)
  }
}

async function walk(e: FsEntry, prefix: string, out: DroppedEntry[]): Promise<void> {
  if (e.isFile) {
    out.push({ file: await readFile(e), relPath: prefix + e.name })
  } else if (e.isDirectory) {
    // 隐藏目录（.git、.obsidian）不进去，避免读大量无用文件
    if (e.name.startsWith('.')) return
    for (const child of await readAll(e)) await walk(child, `${prefix}${e.name}/`, out)
  }
}

/** 遍历顶层条目（含子目录），entries 为 null 时退回 files。 */
export async function collectEntries(entries: FsEntry[] | null, files: File[]): Promise<DroppedEntry[]> {
  if (!entries) return files.map((file) => ({ file, relPath: file.name }))
  const out: DroppedEntry[] = []
  for (const e of entries) await walk(e, '', out)
  return out
}

// 导入本地文档的纯函数：路径规划与文本解码。不依赖 stores，便于单测。
import { basename, dirname, join } from '../../lib/paths'

export interface ImportEntry {
  /** 带 name / size / arrayBuffer 即可，测试里不必构造真正的 File */
  file: Pick<File, 'name' | 'size'>
  /** 相对选择根的路径（"/" 分隔），文件夹导入时为 webkitRelativePath，单文件为文件名 */
  relPath: string
}

export interface ImportItem<F = ImportEntry['file']> {
  path: string
  file: F
}

export interface ImportSkip {
  name: string
  reason: string
}

export interface ImportPlan<F = ImportEntry['file']> {
  items: ImportItem<F>[]
  skipped: ImportSkip[]
}

/** 与后端 JSON 请求体上限一致，超出的文件跳过。 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

const TEXT_EXT = /\.(md|markdown|txt)$/i
// 后端 sanitizeFileName 的字符集，再加上前端 invalidNameReason 额外禁止的 # ^ [ ]
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"|?*#^[\]\\\u0000-\u001f]/g

/** 规范化一个路径段；规范化后为空返回 ''。 */
function cleanSegment(seg: string): string {
  return seg.replace(BAD_CHARS, '-').replace(/[\s.]+$/, '').replace(/^\s+/, '')
}

/** 把导入文件映射到 vault 路径；不该导入的返回跳过原因。 */
export function planOne(entry: ImportEntry, targetDir: string): { path: string } | { skip: string } {
  const { file } = entry
  const segs = entry.relPath.replace(/\\/g, '/').split('/').filter((s) => s !== '')
  if (!segs.length) segs.push(file.name)
  if (segs.some((s) => s.startsWith('.'))) return { skip: '隐藏文件或目录' }
  if (!TEXT_EXT.test(file.name)) return { skip: '不是 Markdown 或文本文件' }
  if (file.size > MAX_IMPORT_BYTES) return { skip: '文件超过 32 MB' }

  const last = segs.pop() as string
  const dirs = segs.map(cleanSegment).filter(Boolean)
  const stem = cleanSegment(last.replace(TEXT_EXT, ''))
  return { path: join(targetDir, ...dirs, `${stem || '未命名'}.md`) }
}

export function buildImportPlan<F extends ImportEntry['file']>(
  entries: { file: F; relPath: string }[],
  targetDir: string,
): ImportPlan<F> {
  const items: ImportItem<F>[] = []
  const skipped: ImportSkip[] = []
  for (const e of entries) {
    const r = planOne(e, targetDir)
    if ('skip' in r) skipped.push({ name: e.relPath || e.file.name, reason: r.skip })
    else items.push({ path: r.path, file: e.file })
  }
  // 父目录在前，便于按目录顺序导入
  items.sort((a, b) => dirname(a.path).localeCompare(dirname(b.path)) || basename(a.path).localeCompare(basename(b.path)))
  return { items, skipped }
}

/** 解码文本：优先严格 UTF-8，失败回退 GB18030；去掉 BOM，保留换行。 */
export function decodeText(buf: ArrayBuffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      text = new TextDecoder('gb18030').decode(buf)
    } catch {
      text = new TextDecoder('utf-8').decode(buf)
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

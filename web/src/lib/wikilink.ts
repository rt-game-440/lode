// [[wikilink]] 的解析规则，与后端 server/internal/notes/links.go 保持一致。
import { dirname } from './paths'

export interface ParsedLink {
  target: string
  heading: string
  alias: string
}

/** 解析 [[ 与 ]] 之间的内容。 */
export function parseLinkInner(inner: string): ParsedLink {
  let [targetPart, ...aliasParts] = inner.split('|')
  let alias = aliasParts.join('|')
  if (aliasParts.length) targetPart = targetPart.replace(/\\$/, '')
  const hashAt = targetPart.indexOf('#')
  const target = (hashAt < 0 ? targetPart : targetPart.slice(0, hashAt)).trim()
  const heading = hashAt < 0 ? '' : targetPart.slice(hashAt + 1).trim()
  alias = alias.trim()
  return { target, heading, alias }
}

/** 规范化链接目标：小写、去掉 .md、去掉开头的 ./ 和 /。 */
export function normalizeTarget(t: string): string {
  let s = t.trim().replace(/\\/g, '/')
  if (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/^\/+/, '')
  s = s.replace(/\.md$/i, '')
  return s.trim().toLowerCase()
}

interface Indexed {
  path: string
  key: string // 小写、去 .md 的路径
  base: string // 小写、去 .md 的文件名
}

/** 根据笔记路径列表解析链接目标的索引。 */
export class LinkResolver {
  private byKey = new Map<string, Indexed>()
  private byBase = new Map<string, Indexed[]>()

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      const key = path.replace(/\.md$/i, '').toLowerCase()
      const i = key.lastIndexOf('/')
      const item = { path, key, base: i < 0 ? key : key.slice(i + 1) }
      this.byKey.set(key, item)
      const list = this.byBase.get(item.base)
      if (list) list.push(item)
      else this.byBase.set(item.base, [item])
    }
  }

  /** 返回目标笔记的路径；找不到时返回 null。 */
  resolve(target: string, srcPath: string): string | null {
    const t = normalizeTarget(target)
    if (!t) return null
    if (t.includes('/')) {
      const exact = this.byKey.get(t)
      if (exact) return exact.path
      const base = t.slice(t.lastIndexOf('/') + 1)
      const cands = (this.byBase.get(base) ?? []).filter((c) => c.key.endsWith('/' + t))
      return pick(cands, '')?.path ?? null
    }
    return pick(this.byBase.get(t) ?? [], dirname(srcPath))?.path ?? null
  }
}

function pick(cands: Indexed[], srcDir: string): Indexed | null {
  if (!cands.length) return null
  return [...cands].sort((a, b) => {
    if (srcDir) {
      const sa = dirname(a.path) === srcDir
      const sb = dirname(b.path) === srcDir
      if (sa !== sb) return sa ? -1 : 1
    }
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })[0]
}

/** 为某篇笔记生成插入用的链接文本：名称唯一时只写名称，否则写不带 .md 的完整路径。 */
export function linkTextFor(path: string, allPaths: string[]): string {
  const noExt = path.replace(/\.md$/i, '')
  const base = noExt.slice(noExt.lastIndexOf('/') + 1)
  const lower = base.toLowerCase()
  const dup = allPaths.some((p) => p !== path && (p.replace(/\.md$/i, '').split('/').pop() ?? '').toLowerCase() === lower)
  return dup ? noExt : base
}

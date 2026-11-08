/**
 * 单篇笔记的外观（页宽、字体），存在笔记 front matter 的 `lode` 键下：
 *
 *   ---
 *   tags: [读书]
 *   lode:
 *     width: wide
 *     font: serif
 *   ---
 *
 * - 只认文档第 1 行是 `---`、下一行像 YAML 键（或直接结束）的 front matter，与编辑器的解析一致；
 * - 写入只改 `lode` 这几行，其余 front matter 原样保留；默认值不写，键全部删掉后 `lode` 行也删掉，
 *   front matter 里没有别的内容时整块删除；
 * - `lode` 下认不出的子键原样保留，方便以后扩展。
 */

export type PageWidth = 'narrow' | 'standard' | 'wide'
export type NoteFont = 'sans' | 'serif' | 'mono'

export interface NoteAppearance {
  width: PageWidth
  font: NoteFont
}

export const DEFAULT_APPEARANCE: NoteAppearance = { width: 'standard', font: 'sans' }

export const PAGE_WIDTHS: PageWidth[] = ['narrow', 'standard', 'wide']
export const NOTE_FONTS: NoteFont[] = ['sans', 'serif', 'mono']

/** front matter 里的命名空间键 */
export const APPEARANCE_KEY = 'lode'

const YAML_KEY = /^[\p{L}\p{N}_-]+\s*:/u
const FENCE = /^---\s*$/
const CLOSE = /^(---|\.\.\.)\s*$/
const LODE_LINE = new RegExp(`^${APPEARANCE_KEY}\\s*:(.*)$`)
const CHILD_LINE = /^([ \t]+)([\p{L}\p{N}_-]+)\s*:\s*(.*?)\s*$/u

interface Line {
  text: string
  from: number
  /** 不含换行符的终点 */
  to: number
}

function splitLines(text: string): Line[] {
  const out: Line[] = []
  let from = 0
  for (;;) {
    const nl = text.indexOf('\n', from)
    const end = nl < 0 ? text.length : nl
    const raw = text.slice(from, end)
    const cr = raw.endsWith('\r') ? 1 : 0
    out.push({ text: raw.slice(0, raw.length - cr), from, to: end - cr })
    if (nl < 0) return out
    from = nl + 1
  }
}

/** front matter 的结构：closeIdx 是结束行的下标；lode 是 `lode:` 行及其子行的下标区间（含两端）。 */
interface Parsed {
  lines: Line[]
  closeIdx: number
  lode: { start: number; end: number; inline: string | null; children: { key: string; value: string; raw: string }[] } | null
}

function parse(text: string): Parsed | null {
  if (!text.startsWith('---')) return null
  const lines = splitLines(text)
  if (lines.length < 2 || !FENCE.test(lines[0].text)) return null
  if (!YAML_KEY.test(lines[1].text) && !FENCE.test(lines[1].text)) return null
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i].text)) {
      closeIdx = i
      break
    }
  }
  if (closeIdx < 0) return null
  let lode: Parsed['lode'] = null
  for (let i = 1; i < closeIdx; i++) {
    const m = LODE_LINE.exec(lines[i].text)
    if (!m) continue
    const rest = m[1].trim()
    let end = i
    const children: { key: string; value: string; raw: string }[] = []
    if (rest === '' || rest.startsWith('#')) {
      for (let j = i + 1; j < closeIdx; j++) {
        const t = lines[j].text
        if (!/^[ \t]/.test(t) || t.trim() === '') break
        end = j
        const c = CHILD_LINE.exec(t)
        children.push({ key: c ? c[2] : '', value: c ? unquote(stripComment(c[3])) : '', raw: t })
      }
    }
    lode = { start: i, end, inline: rest === '' || rest.startsWith('#') ? null : rest, children }
    break
  }
  return { lines, closeIdx, lode }
}

function stripComment(v: string): string {
  return v.replace(/\s+#.*$/, '').trim()
}

function unquote(v: string): string {
  const m = /^(['"])(.*)\1$/.exec(v)
  return m ? m[2] : v
}

/** `{width: wide, font: serif}` 这种行内写法 */
function parseFlow(v: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = /^\{(.*)\}$/.exec(stripComment(v))
  if (!body) return out
  for (const part of body[1].split(',')) {
    const [k, ...rest] = part.split(':')
    if (!k || !rest.length) continue
    out[k.trim()] = unquote(rest.join(':').trim())
  }
  return out
}

function values(p: Parsed): Record<string, string> {
  if (!p.lode) return {}
  if (p.lode.inline !== null) return parseFlow(p.lode.inline)
  const out: Record<string, string> = {}
  for (const c of p.lode.children) if (c.key) out[c.key] = c.value
  return out
}

function asWidth(v: string | undefined): PageWidth {
  return PAGE_WIDTHS.includes(v as PageWidth) ? (v as PageWidth) : DEFAULT_APPEARANCE.width
}

function asFont(v: string | undefined): NoteFont {
  return NOTE_FONTS.includes(v as NoteFont) ? (v as NoteFont) : DEFAULT_APPEARANCE.font
}

/** 读取笔记的外观；没写或写了认不出的值时用默认值。 */
export function readAppearance(text: string): NoteAppearance {
  const p = parse(text)
  if (!p) return { ...DEFAULT_APPEARANCE }
  const v = values(p)
  return { width: asWidth(v.width), font: asFont(v.font) }
}

/** 键名到外观字段：front matter 里用的键和 NoteAppearance 的字段同名 */
const FIELDS = ['width', 'font'] as const

/**
 * 把外观写回 front matter，返回新的全文（没有变化时原样返回）。
 * 默认值不写；`lode` 下没有任何键时删掉这一项；front matter 因此变空时整块删掉。
 */
export function writeAppearance(text: string, patch: Partial<NoteAppearance>): string {
  const p = parse(text)
  const cur = p ? values(p) : {}
  const next: Record<string, string> = { ...cur }
  for (const f of FIELDS) {
    if (!(f in patch)) continue
    const v = patch[f]!
    if (v === DEFAULT_APPEARANCE[f]) delete next[f]
    else next[f] = v
  }
  if (FIELDS.every((f) => cur[f] === next[f])) return text

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  // 原有的子行：认识的键按新值改写或删除，认不出的行原样保留
  const block: string[] = []
  const inline = p?.lode?.inline ?? null
  if (inline !== null) {
    const entries = Object.entries(next)
    if (entries.length) block.push(`${APPEARANCE_KEY}: {${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}}`)
  } else {
    const indent = p?.lode?.children.find((c) => c.key)?.raw.match(/^[ \t]+/)?.[0] ?? '  '
    const children: string[] = []
    const written = new Set<string>()
    for (const c of p?.lode?.children ?? []) {
      if ((FIELDS as readonly string[]).includes(c.key)) {
        if (c.key in next && !written.has(c.key)) children.push(`${indent}${c.key}: ${next[c.key]}`)
        written.add(c.key)
      } else {
        children.push(c.raw)
      }
    }
    for (const f of FIELDS) if (f in next && !written.has(f)) children.push(`${indent}${f}: ${next[f]}`)
    if (children.length) block.push(`${APPEARANCE_KEY}:`, ...children)
  }

  if (!p) {
    if (!block.length) return text
    return ['---', ...block, '---'].join(eol) + eol + text
  }

  const { lines, closeIdx, lode } = p
  const inner = lines.slice(1, closeIdx).map((l) => l.text)
  // inner 的下标比 lines 小 1
  if (lode) inner.splice(lode.start - 1, lode.end - lode.start + 1, ...block)
  else inner.push(...block)

  const restFrom = closeIdx + 1 < lines.length ? lines[closeIdx + 1].from : text.length
  const rest = text.slice(restFrom)
  if (inner.every((l) => l.trim() === '')) return rest
  const head = text.slice(0, lines[1].from)
  const close = text.slice(lines[closeIdx].from, restFrom)
  return head + inner.map((l) => l + eol).join('') + close + rest
}

/**
 * 编辑器里要藏起来的 front matter 区间（偏移，[from, to] 都是整行的边界，不含末尾换行）：
 * - front matter 里只有 `lode`（和空行）时藏起整块；
 * - 还有别的键时只藏 `lode` 这几行。
 * 区间后面必须还有一行（光标停在那里），否则不藏。
 */
export function hiddenAppearanceRange(text: string): { from: number; to: number; whole: boolean } | null {
  const p = parse(text)
  if (!p?.lode) return null
  const { lines, closeIdx, lode } = p
  const whole = lines.slice(1, closeIdx).every((l, i) => (i + 1 >= lode.start && i + 1 <= lode.end) || l.text.trim() === '')
  if (whole) {
    if (closeIdx + 1 >= lines.length) return null
    return { from: 0, to: lines[closeIdx].to, whole: true }
  }
  return { from: lines[lode.start].from, to: lines[lode.end].to, whole: false }
}

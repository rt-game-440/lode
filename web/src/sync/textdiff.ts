import { ChangeSet, Text } from '@codemirror/state'

/** 一处文本替换：把 [from, to) 换成 insert（字符偏移，基于原文）。 */
export interface TextChange {
  from: number
  to: number
  insert: string
}

/** LCS 表的单元格上限；超过时中间部分整体当作一处替换（只是更粗，不会出错）。 */
const MAX_CELLS = 2_000_000

function splitLines(s: string): string[] {
  if (!s) return []
  const out = s.split('\n').map((l, i, arr) => (i < arr.length - 1 ? l + '\n' : l))
  if (out[out.length - 1] === '') out.pop()
  return out
}

/** 按行比较 a 和 b，返回把 a 变成 b 的替换列表（按位置升序、互不重叠）。 */
export function diffChanges(a: string, b: string): TextChange[] {
  if (a === b) return []
  const x = splitLines(a)
  const y = splitLines(b)
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const xm = x.slice(pre, x.length - suf)
  const ym = y.slice(pre, y.length - suf)
  // 每行在 a 中的起始偏移
  const offs: number[] = [0]
  for (const l of x) offs.push(offs[offs.length - 1] + l.length)
  const at = (line: number) => offs[line]

  const n = xm.length
  const m = ym.length
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [{ from: at(pre), to: at(pre + n), insert: ym.join('') }]
  }
  const w = m + 1
  const lcs = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = xm[i] === ym[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const out: TextChange[] = []
  let cur: { start: number; end: number; lines: string[] } | null = null
  const push = () => {
    if (cur) out.push({ from: at(pre + cur.start), to: at(pre + cur.end), insert: cur.lines.join('') })
    cur = null
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) {
      push()
      i++
      j++
      continue
    }
    cur ??= { start: i, end: i, lines: [] }
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      cur.lines.push(ym[j++])
    } else {
      cur.end = ++i
    }
  }
  push()
  return out
}

export function toText(s: string): Text {
  return Text.of(s.split('\n'))
}

/** 把 a → b 的差异表示为 CodeMirror 的 ChangeSet（基于 a）。 */
export function diffChangeSet(a: string, b: string): ChangeSet {
  // insert 传 Text 而不是字符串：字符串会按 CRLF 规范化，丢掉行尾的 CR
  return ChangeSet.of(
    diffChanges(a, b).map((c) => ({ ...c, insert: toText(c.insert) })),
    a.length,
  )
}

/**
 * 变基：mine 和 theirs 都从 base 改出来。把 theirs 的改动映射到 mine 之上，
 * 返回同时包含两边改动的文本。用于本地还有未发送的修改时，套用服务器返回的合并结果。
 */
export function rebase(base: string, theirs: string, mine: string): string {
  if (mine === base) return theirs
  if (theirs === base) return mine
  const local = diffChangeSet(base, mine)
  const remote = diffChangeSet(base, theirs)
  return remote.map(local).apply(toText(mine)).toString()
}

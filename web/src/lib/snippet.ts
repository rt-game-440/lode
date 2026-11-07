/** 把带 \u0002 \u0003 高亮标记的片段拆成文本段。 */
export interface Segment {
  text: string
  hit: boolean
}

export function splitSnippet(s: string): Segment[] {
  const out: Segment[] = []
  let hit = false
  let buf = ''
  for (const ch of s) {
    if (ch === '\u0002' || ch === '\u0003') {
      if (buf) out.push({ text: buf, hit })
      buf = ''
      hit = ch === '\u0002'
      continue
    }
    buf += ch === '\n' ? ' ' : ch
  }
  if (buf) out.push({ text: buf, hit })
  return out
}

/** 简单的模糊匹配评分：子序列匹配，连续命中与词首命中加分。不匹配返回 -1。 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const t = text.toLowerCase()
  if (!q) return 0
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - (found - ti)
    if (found === 0 || '/ -_'.includes(t[found - 1])) score += 8
    ti = found + 1
  }
  return score
}

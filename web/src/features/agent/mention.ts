import type { Message } from '../../api/agent'
import type { Note } from '../../api/types'

/** 光标处正在输入的 @ 提及：start 是 @ 的位置，query 是 @ 之后到光标的文字。 */
export interface MentionQuery {
  start: number
  query: string
}

/**
 * 光标前最近的一个 @ 若在行首或空白之后、且它到光标之间没有空白，就是一次进行中的提及。
 * 邮箱里的 a@b 不算（@ 前不是空白）。
 */
export function findMention(text: string, caret: number): MentionQuery | null {
  for (let i = caret - 1; i >= 0; i--) {
    const c = text[i]
    if (/\s/.test(c)) return null
    if (c === '@') {
      if (i > 0 && !/\s/.test(text[i - 1])) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
  }
  return null
}

/** 按标题和路径过滤，最近修改的在前，排除已附上的。 */
export function filterNotes(notes: Record<string, Note>, query: string, exclude: string[] = [], limit = 30): Note[] {
  const k = query.trim().toLowerCase()
  const skip = new Set(exclude)
  const hit = Object.values(notes).filter(
    (n) => !skip.has(n.path) && (!k || n.title.toLowerCase().includes(k) || n.path.toLowerCase().includes(k)),
  )
  return hit.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/** 本会话之前的用户消息里已经附过的笔记路径。 */
export function sentMentions(messages: Message[] | undefined): string[] {
  return (messages ?? []).filter((m) => m.role === 'user').flatMap((m) => m.meta.mentions ?? [])
}

/**
 * 这一轮要附上的笔记：用户明确附上的，加上自动附上的当前笔记。
 * 当前笔记只在没被移除、也没在之前的消息里附过时自动附上。
 */
export function resolveMentions(opts: {
  contextPath: string | undefined
  mentions: string[]
  suppressed: string[]
  sent: string[]
}): { all: string[]; auto: boolean } {
  const { contextPath, mentions, suppressed, sent } = opts
  const auto = !!contextPath && !mentions.includes(contextPath) && !suppressed.includes(contextPath) && !sent.includes(contextPath)
  return { all: [...(auto && contextPath ? [contextPath] : []), ...mentions], auto }
}

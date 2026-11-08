import { EditorSelection, type EditorState, type Line, type TransactionSpec } from '@codemirror/state'

/**
 * 手机工具栏用的 Markdown 格式命令。都是 EditorState → TransactionSpec 的纯函数，
 * 由调用方 dispatch，便于单测。
 */

const HEADING = /^(#{1,6})\s+/
const LIST = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?)?/

function done(spec: TransactionSpec): TransactionSpec {
  return { ...spec, scrollIntoView: true, userEvent: 'input.format' }
}

/** 选区覆盖的行（选区恰好止于下一行行首时不算那一行）。 */
function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>()
  const lines: Line[] = []
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    let last = state.doc.lineAt(r.to).number
    if (!r.empty && last > first && state.doc.line(last).from === r.to) last--
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      lines.push(state.doc.line(n))
    }
  }
  return lines
}

/** 行首前缀的替换，光标跟着文字走（插在光标处的前缀放到光标前面）。 */
function replacePrefixes(state: EditorState, edits: { from: number; to: number; insert: string }[]): TransactionSpec {
  const changes = state.changes(edits)
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => EditorSelection.range(changes.mapPos(r.anchor, 1), changes.mapPos(r.head, 1))),
    state.selection.mainIndex,
  )
  return done({ changes, selection })
}

/** 标题循环：普通 → # → ## → ### → 普通。 */
export function cycleHeading(state: EditorState): TransactionSpec {
  const edits = selectedLines(state).map((line) => {
    const m = HEADING.exec(line.text)
    const level = m ? m[1].length : 0
    const next = level >= 3 ? '' : `${'#'.repeat(level + 1)} `
    return { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next }
  })
  return replacePrefixes(state, edits)
}

/** 切换无序列表或任务：所有行都已是该类型时去掉标记，否则统一换成该标记（保留缩进）。 */
export function toggleList(state: EditorState, kind: 'bullet' | 'task'): TransactionSpec {
  const lines = selectedLines(state)
  const parsed = lines.map((line) => {
    const m = LIST.exec(line.text)!
    const type = !m[2] ? 'none' : m[3] ? 'task' : 'bullet'
    return { line, indent: m[1], markerEnd: m[0].length, type }
  })
  const all = parsed.every((p) => p.type === kind)
  const marker = kind === 'task' ? '- [ ] ' : '- '
  const edits = parsed.map(({ line, indent, markerEnd }) => ({
    from: line.from + indent.length,
    to: line.from + markerEnd,
    insert: all ? '' : marker,
  }))
  return replacePrefixes(state, edits)
}

/**
 * 切换行内标记（加粗 **、斜体 *、行内代码 `）：
 * 已被标记包住（选中文字自带标记，或标记就在选区两侧）时去掉，否则包起来。
 * 空选区插入一对标记，光标停在中间；在一对空标记中间再次触发则删除它们。
 */
export function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const n = mark.length
  return done(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to)
      const before = state.sliceDoc(Math.max(0, r.from - n), r.from)
      const after = state.sliceDoc(r.to, Math.min(state.doc.length, r.to + n))
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: r.from - n, to: r.from },
            { from: r.to, to: r.to + n },
          ],
          range: EditorSelection.range(r.from - n, r.to - n),
        }
      }
      if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: { from: r.from, to: r.to, insert: text.slice(n, text.length - n) },
          range: EditorSelection.range(r.from, r.to - 2 * n),
        }
      }
      return {
        changes: { from: r.from, to: r.to, insert: mark + text + mark },
        range: r.empty ? EditorSelection.cursor(r.from + n) : EditorSelection.range(r.from + n, r.to + n),
      }
    }),
  )
}

/** 切换引用：所有选中行都以 > 开头时去掉，否则统一加上。 */
export function toggleQuote(state: EditorState): TransactionSpec {
  const lines = selectedLines(state)
  const all = lines.every((l) => /^>\s?/.test(l.text))
  const edits = lines.map((line) => {
    const m = /^>\s?/.exec(line.text)
    return all ? { from: line.from, to: line.from + m![0].length, insert: '' } : { from: line.from, to: line.from, insert: '> ' }
  })
  return replacePrefixes(state, edits)
}

/** 插入链接：有选区时把选中文字作为链接文字，光标停在地址处；否则光标停在方括号里。 */
export function insertLink(state: EditorState): TransactionSpec {
  return done(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to)
      const insert = `[${text}]()`
      const at = r.empty ? r.from + 1 : r.from + text.length + 3
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(at) }
    }),
  )
}

/** 插入笔记链接 [[ ]]：空选区时光标在中间（调用方随后打开补全），有选区时包起来。 */
export function insertWikiLink(state: EditorState): TransactionSpec {
  return done(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to)
      const insert = `[[${text}]]`
      const at = r.empty ? r.from + 2 : r.from + insert.length
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(at) }
    }),
  )
}

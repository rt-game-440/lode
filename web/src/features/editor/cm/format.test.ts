import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cycleHeading, insertLink, insertWikiLink, toggleList } from './format'

/** 用 | 标出光标，[ 和 ] 标出选区。 */
function state(text: string) {
  const a = text.indexOf('[')
  const b = text.indexOf(']')
  if (a >= 0 && b > a && text[a + 1] !== '[') {
    const doc = text.slice(0, a) + text.slice(a + 1, b) + text.slice(b + 1)
    return EditorState.create({ doc, selection: EditorSelection.range(a, b - 1) })
  }
  const at = text.indexOf('|')
  return EditorState.create({ doc: text.replace('|', ''), selection: { anchor: at } })
}

function apply(s: EditorState, spec: TransactionSpec): string {
  const next = s.update(spec).state
  const doc = next.doc.toString()
  const r = next.selection.main
  if (r.empty) return `${doc.slice(0, r.head)}|${doc.slice(r.head)}`
  return `${doc.slice(0, r.from)}«${doc.slice(r.from, r.to)}»${doc.slice(r.to)}`
}

describe('cycleHeading', () => {
  it('普通行 → 一级 → 二级 → 三级 → 普通行', () => {
    let s = state('标|题')
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      s = s.update(cycleHeading(s)).state
      seen.push(s.doc.toString())
    }
    expect(seen).toEqual(['# 标题', '## 标题', '### 标题', '标题'])
  })

  it('光标随文字移动', () => {
    expect(apply(state('标|题'), cycleHeading(state('标|题')))).toBe('# 标|题')
  })
})

describe('toggleList', () => {
  it('普通行加上列表符号，再点一次去掉', () => {
    const s = state('买牛奶|')
    const once = s.update(toggleList(s, 'bullet')).state
    expect(once.doc.toString()).toBe('- 买牛奶')
    expect(once.update(toggleList(once, 'bullet')).state.doc.toString()).toBe('买牛奶')
  })

  it('列表项转成任务，保留缩进', () => {
    const s = state('  - 回|复邮件')
    expect(s.update(toggleList(s, 'task')).state.doc.toString()).toBe('  - [ ] 回复邮件')
  })

  it('选中多行时每行都处理', () => {
    const s = EditorState.create({ doc: 'a\nb\nc', selection: EditorSelection.range(0, 3) })
    expect(s.update(toggleList(s, 'task')).state.doc.toString()).toBe('- [ ] a\n- [ ] b\nc')
  })
})

describe('insertLink', () => {
  it('有选区时包成链接，光标放在括号里等待输入地址', () => {
    expect(apply(state('看[文档]吧'), insertLink(state('看[文档]吧')))).toBe('看[文档](|)吧')
  })
  it('没有选区时插入空链接，光标在方括号里', () => {
    expect(apply(state('看|吧'), insertLink(state('看|吧')))).toBe('看[|]()吧')
  })
})

describe('insertWikiLink', () => {
  it('插入成对的 [[ ]]，光标在中间', () => {
    expect(apply(state('见|'), insertWikiLink(state('见|')))).toBe('见[[|]]')
  })
  it('有选区时包成笔记链接', () => {
    expect(apply(state('见[项目]'), insertWikiLink(state('见[项目]')))).toBe('见[[项目]]|')
  })
})

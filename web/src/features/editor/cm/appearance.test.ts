import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { writeAppearance } from '../../../lib/noteAppearance'
import { diffChangeSet } from '../../../sync/textdiff'
import { appearanceOf, appearanceWrite, bodyStart, noteAppearance } from './appearance'

const ONLY = '---\nlode:\n  font: serif\n---\n正文第一行\n第二行'
const MIXED = '---\ntags: [a]\nlode:\n  width: wide\n---\n正文'

function make(doc: string, anchor = 0) {
  const seen: { font: string; animate: boolean }[] = []
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: noteAppearance(() => false, (a, animate) => seen.push({ font: a.font, animate })),
  })
  return { state, seen }
}

describe('编辑器里的笔记外观', () => {
  it('从 front matter 读出外观', () => {
    expect(appearanceOf(make(ONLY).state)).toEqual({ width: 'standard', font: 'serif' })
    expect(appearanceOf(make(MIXED).state)).toEqual({ width: 'wide', font: 'sans' })
  })

  it('光标进不了整块藏起的 front matter，停在正文开头', () => {
    const { state } = make(ONLY, bodyStart(ONLY))
    const start = ONLY.indexOf('正文')
    expect(bodyStart(ONLY)).toBe(start)
    // Ctrl+Home、全选都落在正文开头
    expect(state.update({ selection: { anchor: 0 } }).state.selection.main.head).toBe(start)
    const all = state.update({ selection: EditorSelection.range(0, state.doc.length) }).state.selection.main
    expect([all.from, all.to]).toEqual([start, state.doc.length])
  })

  it('只藏几行时，光标往上停在上一行行尾，往下停在下一行行首', () => {
    const { state } = make(MIXED)
    const lode = MIXED.indexOf('lode:')
    const close = MIXED.indexOf('---\n正文')
    const below = state.update({ selection: { anchor: close } }).state
    expect(below.update({ selection: { anchor: lode + 2 } }).state.selection.main.head).toBe(lode - 1)
    const above = state.update({ selection: { anchor: lode - 1 } }).state
    expect(above.update({ selection: { anchor: lode + 2 } }).state.selection.main.head).toBe(close)
  })

  it('普通编辑改不到藏起的部分，在两端插入照常', () => {
    const start = ONLY.indexOf('正文')
    const { state } = make(ONLY, start)
    // 正文开头按退格：删掉前面的换行会破坏 front matter，被拦下
    expect(state.update({ changes: { from: start - 1, to: start } }).state.doc.toString()).toBe(ONLY)
    // 在正文开头输入
    expect(state.update({ changes: { from: start, insert: 'x' } }).state.doc.toString()).toBe(ONLY.replace('正文', 'x正文'))

    const m = make(MIXED).state
    const lode = MIXED.indexOf('lode:')
    // 上一行行尾输入照常，删掉它后面的换行被拦下
    expect(m.update({ changes: { from: lode - 1, insert: ', b' } }).state.doc.toString()).toContain('tags: [a], b\nlode:')
    expect(m.update({ changes: { from: lode - 1, to: lode } }).state.doc.toString()).toBe(MIXED)
  })

  it('菜单写入、撤销重做和受信任的事务可以改动藏起的部分', () => {
    const { state, seen } = make(ONLY, bodyStart(ONLY))
    const next = writeAppearance(ONLY, { font: 'mono' })
    const tr = state.update({ changes: diffChangeSet(ONLY, next), annotations: appearanceWrite.of(true) })
    expect(tr.state.doc.toString()).toBe(next)
    expect(appearanceOf(tr.state).font).toBe('mono')
    const undo = state.update({ changes: diffChangeSet(ONLY, next), annotations: Transaction.userEvent.of('undo') })
    expect(undo.state.doc.toString()).toBe(next)
    // 状态层面不实例化视图插件，onAppearance 只由视图调用
    expect(seen).toEqual([])
  })

  it('外观写入在正文开头的光标后面新建 front matter 时，光标仍在正文开头', () => {
    const doc = '正文'
    const { state } = make(doc, 0)
    const next = writeAppearance(doc, { font: 'serif' })
    const s = state.update({ changes: diffChangeSet(doc, next), annotations: appearanceWrite.of(true) }).state
    expect(s.selection.main.head).toBe(next.indexOf('正文'))
  })
})

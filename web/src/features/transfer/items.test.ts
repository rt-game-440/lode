import { describe, expect, it } from 'vitest'
import type { Note, TransferResult } from '../../api/types'
import { affectedNotes, brokenLinksWarning, describeItems, normalizeSelection, renameLabel, resultMessage } from './items'

const note = (id: string, path: string): Note => ({
  id,
  path,
  title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  rev: 1,
  hash: '',
  size: 0,
  mtime: 0,
  created_at: 0,
  updated_at: 0,
})

describe('normalizeSelection', () => {
  it('去掉重复项和已选文件夹里的条目，按路径排序', () => {
    const items = normalizeSelection([
      { kind: 'note', path: 'z.md', id: 'z' },
      { kind: 'folder', path: '资料' },
      { kind: 'note', path: '资料/a.md', id: 'a' },
      { kind: 'folder', path: '资料/子' },
      { kind: 'note', path: 'z.md', id: 'z' },
      { kind: 'note', path: '资料x/b.md', id: 'b' },
    ])
    expect(items).toEqual([
      { kind: 'note', id: 'z' },
      { kind: 'folder', path: '资料' },
      { kind: 'note', id: 'b' },
    ])
  })
})

describe('affectedNotes / describeItems', () => {
  const notes = Object.fromEntries([note('a', '资料/a.md'), note('b', '资料/子/b.md'), note('c', 'c.md'), note('d', '资料x.md')].map((n) => [n.id, n]))
  it('文件夹包含其下全部笔记', () => {
    expect([...affectedNotes([{ kind: 'folder', path: '资料' }, { kind: 'note', id: 'c' }], notes)].sort()).toEqual(['a', 'b', 'c'])
  })
  it('描述条目', () => {
    expect(describeItems([{ kind: 'note', id: 'c' }], notes)).toBe('笔记“c”')
    expect(describeItems([{ kind: 'folder', path: '资料/子' }], notes)).toBe('文件夹“子”')
    expect(describeItems([{ kind: 'note', id: 'c' }, { kind: 'note', id: 'd' }], notes)).toBe('2 项')
  })
})

describe('结果提示', () => {
  const base: TransferResult = {
    mode: 'copy',
    dry_run: false,
    source_workspace: 'default',
    target_workspace: 'k3f9a2',
    target_dir: '',
    items: [],
    notes: [],
    attachments: [],
    renamed: [],
    broken_links: 0,
    trashed: 0,
  }
  it('没有改名', () => {
    expect(resultMessage(base, '工作')).toBe('已复制到“工作”')
    expect(resultMessage({ ...base, mode: 'move' }, '工作')).toBe('已移动到“工作”')
  })
  it('列出改名项，超过 3 个写“等 N 项”', () => {
    const renamed = [
      { kind: 'note' as const, from: '笔记.md', to: '笔记 1.md' },
      { kind: 'folder' as const, from: '资料/项目', to: '项目 1' },
      { kind: 'attachment' as const, from: 'attachments/图.png', to: 'attachments/图-1.png' },
      { kind: 'note' as const, from: 'x.md', to: 'x 1.md' },
    ]
    expect(resultMessage({ ...base, renamed: renamed.slice(0, 1) }, '工作')).toBe('已复制到“工作”；重名已自动改名：笔记 → 笔记 1')
    expect(resultMessage({ ...base, renamed }, '工作')).toBe(
      '已复制到“工作”；重名已自动改名：笔记 → 笔记 1，项目 → 项目 1，attachments/图.png → attachments/图-1.png 等 4 项',
    )
    expect(renameLabel(renamed[1])).toBe('项目 → 项目 1')
  })
  it('会失效的链接', () => {
    expect(brokenLinksWarning(0)).toBe('')
    expect(brokenLinksWarning(3)).toBe('其他笔记里指向它的 3 个链接会失效。')
  })
})

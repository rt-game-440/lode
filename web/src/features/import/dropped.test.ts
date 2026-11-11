import { describe, expect, it } from 'vitest'
import { type FsEntry, collectEntries, hasImportableDrop } from './dropped'

const file = (name: string): FsEntry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File(['x'], name)),
})

/** batchSize：每次 readEntries 返回的条数，模拟分批读取。 */
const dir = (name: string, children: FsEntry[], batchSize = 2): FsEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0
    return {
      readEntries: (ok) => {
        const batch = children.slice(i, i + batchSize)
        i += batchSize
        ok(batch)
      },
    }
  },
})

describe('collectEntries', () => {
  it('递归遍历并拼出相对路径，分批读取不丢条目', async () => {
    const root = dir('笔记库', [file('a.md'), file('b.md'), file('c.txt'), dir('sub', [file('d.md')])])
    const out = await collectEntries([root], [])
    expect(out.map((e) => e.relPath).sort()).toEqual(['笔记库/a.md', '笔记库/b.md', '笔记库/c.txt', '笔记库/sub/d.md'])
  })

  it('不进入以 . 开头的目录', async () => {
    const root = dir('v', [dir('.obsidian', [file('x.md')]), file('ok.md')])
    const out = await collectEntries([root], [])
    expect(out.map((e) => e.relPath)).toEqual(['v/ok.md'])
  })

  it('顶层单文件的 relPath 只是文件名', async () => {
    const out = await collectEntries([file('one.md')], [])
    expect(out.map((e) => e.relPath)).toEqual(['one.md'])
  })

  it('没有 entries 时退回 files', async () => {
    const out = await collectEntries(null, [new File(['x'], 'f.md')])
    expect(out.map((e) => e.relPath)).toEqual(['f.md'])
  })
})

describe('hasImportableDrop', () => {
  it('有文件夹或文本文件才接管，纯图片不接管', () => {
    expect(hasImportableDrop([dir('d', [])], [])).toBe(true)
    expect(hasImportableDrop(null, [new File(['x'], 'a.TXT')])).toBe(true)
    expect(hasImportableDrop(null, [new File(['x'], 'a.png')])).toBe(false)
  })
})

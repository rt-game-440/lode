import { describe, expect, it } from 'vitest'
import { buildImportPlan, decodeText, MAX_IMPORT_BYTES } from './plan'

const f = (name: string, size = 10) => ({ name, size })

describe('buildImportPlan', () => {
  it('收 md/markdown/txt，统一为 .md，大小写不敏感', () => {
    const p = buildImportPlan(
      [
        { file: f('a.md'), relPath: 'a.md' },
        { file: f('b.TXT'), relPath: 'b.TXT' },
        { file: f('c.markdown'), relPath: 'c.markdown' },
      ],
      '',
    )
    expect(p.items.map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(p.skipped).toEqual([])
  })

  it('保留目录结构并拼到目标目录', () => {
    const p = buildImportPlan([{ file: f('x.md'), relPath: 'docs/sub/x.md' }], '工作')
    expect(p.items[0].path).toBe('工作/docs/sub/x.md')
  })

  it('跳过隐藏目录、其他类型和超大文件，并写明原因', () => {
    const p = buildImportPlan(
      [
        { file: f('a.md'), relPath: 'vault/.obsidian/a.md' },
        { file: f('p.png'), relPath: 'vault/p.png' },
        { file: f('big.md', MAX_IMPORT_BYTES + 1), relPath: 'big.md' },
        { file: f('ok.md'), relPath: 'vault/ok.md' },
      ],
      '',
    )
    expect(p.items.map((i) => i.path)).toEqual(['vault/ok.md'])
    expect(p.skipped.map((s) => s.reason)).toEqual(['隐藏文件或目录', '不是 Markdown 或文本文件', '文件超过 32 MB'])
  })

  it('替换非法字符并处理空名', () => {
    const p = buildImportPlan(
      [
        { file: f('a#b[1].md'), relPath: 'a#b[1].md' },
        { file: f('?.md'), relPath: 'd:x/?.md' },
        { file: f(' .md'), relPath: ' .md' },
      ],
      '',
    )
    expect(p.items.map((i) => i.path).sort()).toEqual(['a-b-1-.md', 'd-x/-.md', '未命名.md'].sort())
  })

  it('反斜杠路径当作分隔符', () => {
    const p = buildImportPlan([{ file: f('x.md'), relPath: 'a\\b\\x.md' }], '')
    expect(p.items[0].path).toBe('a/b/x.md')
  })
})

describe('decodeText', () => {
  it('UTF-8 并去掉 BOM、保留 CRLF', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('你好\r\n')])
    expect(decodeText(bytes.buffer)).toBe('你好\r\n')
  })

  it('非 UTF-8 回退 GB18030', () => {
    // “中文”的 GBK 编码
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(bytes.buffer)).toBe('中文')
  })
})

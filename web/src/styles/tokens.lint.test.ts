import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * tokens 是颜色和动画时长的唯一来源（docs/design.md）：
 * src 下除 styles/tokens 以外的 css / ts / tsx 不允许出现颜色字面量和动画时长字面量。
 */
const SRC = join(__dirname, '..')
const TOKENS_DIR = join(SRC, 'styles', 'tokens')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return p === TOKENS_DIR ? [] : files(p)
    return /\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** 去掉注释，避免说明文字里的例子被误报（保留换行以便报告行号）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const RULES: { name: string; test: (line: string, file: string) => boolean }[] = [
  { name: '十六进制颜色', test: (l) => /(^|[\s:(,'"`=])#[0-9a-fA-F]{3,8}\b(?![-\w])/.test(l) && !/['"`]#[0-9a-fA-F]{3,8}-/.test(l) },
  { name: 'rgb/hsl 颜色', test: (l) => /\b(rgba?|hsla?|oklch|lab|lch)\(/.test(l) },
  { name: '具名颜色', test: (l, f) => f.endsWith('.css') && /:\s*[^;]*\b(white|black)\b/.test(l) },
  { name: 'CSS 动画时长', test: (l, f) => f.endsWith('.css') && /\b(transition|animation)[\w-]*\s*:[^;]*\b\d*\.?\d+m?s\b/.test(l) },
  { name: 'JS 动画时长', test: (l, f) => !f.endsWith('.css') && /\b(duration|delay)\s*:\s*\d/.test(l) },
]

describe('tokens 是颜色和动画时长的唯一来源', () => {
  it('组件和样式里没有硬编码的颜色值和动画时长', () => {
    const found: string[] = []
    for (const f of files(SRC)) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        for (const r of RULES) {
          if (r.test(line, f)) found.push(`${relative(SRC, f).split(sep).join('/')}:${i + 1} ${r.name}：${line.trim()}`)
        }
      })
    }
    expect(found).toEqual([])
  })
})

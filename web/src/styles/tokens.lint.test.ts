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

/** 时长字面量：200ms、.2s、0.35s */
const TIME = /(^|[^\w.-])\d*\.?\d+m?s\b/
const NAMED_COLOR = /\b(white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)\b/

/** 按行检查的规则 */
const LINE_RULES: { name: string; test: (line: string, file: string) => boolean }[] = [
  { name: '十六进制颜色', test: (l) => /(^|[\s:(,'"`=])#[0-9a-fA-F]{3,8}\b(?![-\w])/.test(l) && !/['"`]#[0-9a-fA-F]{3,8}-/.test(l) },
  { name: 'rgb/hsl 颜色', test: (l) => /\b(rgba?|hsla?|oklch|lab|lch)\(/.test(l) },
  { name: 'JS 动画时长', test: (l, f) => !f.endsWith('.css') && /\b(duration|delay)\s*:\s*\.?\d/.test(l) },
  {
    name: 'JS 样式里的时长',
    test: (l, f) => {
      if (f.endsWith('.css')) return false
      const m = /\b(transition|animation)(Duration|Delay)?\s*:\s*(['"`][^'"`]*)/.exec(l)
      return !!m && TIME.test(m[3])
    },
  },
]

/** CSS 按声明检查（声明可能跨行），返回 [规则名, 声明起始偏移]。 */
function cssProblems(text: string): [string, number][] {
  const out: [string, number][] = []
  for (const m of text.matchAll(/(?<![\w-])([a-z-]+)\s*:([^;{}]*)/g)) {
    const [, prop, value] = m
    if (/^(transition|animation)/.test(prop) && TIME.test(value)) out.push(['CSS 动画时长', m.index])
    if (/color|background|border|outline|fill|stroke|shadow/.test(prop) && NAMED_COLOR.test(value)) out.push(['具名颜色', m.index])
  }
  return out
}

function problems(file: string, source: string): string[] {
  const text = stripComments(source)
  const lines = text.split('\n')
  const found: string[] = []
  lines.forEach((line, i) => {
    for (const r of LINE_RULES) if (r.test(line, file)) found.push(`${i + 1} ${r.name}：${line.trim()}`)
  })
  if (file.endsWith('.css')) {
    for (const [rule, at] of cssProblems(text)) {
      const n = text.slice(0, at).split('\n').length
      found.push(`${n} ${rule}：${lines[n - 1].trim()}`)
    }
  }
  return found
}

describe('tokens 是颜色和动画时长的唯一来源', () => {
  it('组件和样式里没有硬编码的颜色值和动画时长', () => {
    const found = files(SRC).flatMap((f) => problems(f, readFileSync(f, 'utf8')).map((p) => `${relative(SRC, f).split(sep).join('/')}:${p}`))
    expect(found).toEqual([])
  })

  it('规则能识别跨行声明、小数时长和 JS 样式字符串', () => {
    expect(problems('a.css', '.x {\n  transition:\n    opacity .2s;\n}')).toHaveLength(1)
    expect(problems('a.css', '.x { border-color: red; }')).toHaveLength(1)
    expect(problems('a.css', '.x { transition: opacity var(--duration-fast) var(--ease-out); color: var(--color-label); }')).toEqual([])
    expect(problems('a.tsx', 'animate(x, 1, { duration: .2 })')).toHaveLength(1)
    expect(problems('a.tsx', "const s = { transition: 'opacity 200ms' }")).toHaveLength(1)
    expect(problems('a.tsx', "const s = { transitionDuration: '0.3s' }")).toHaveLength(1)
    expect(problems('a.tsx', 'const t = { ...springDefault }')).toEqual([])
  })
})

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// 生成阶段截图：LODE_SCREENSHOTS=阶段名 pnpm e2e screenshots
// 输出到 docs/screenshots/<阶段名>/，未设置环境变量时跳过。
const stage = process.env.LODE_SCREENSHOTS
const outDir = stage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', stage) : ''
const PASSWORD = 'e2e-test-password'

test.skip(!stage, '设置 LODE_SCREENSHOTS 后才生成截图')
test.describe.configure({ mode: 'serial' })

const DEMO = `---
tags: [写作, 项目/lode]
---
Lode 把笔记保存为普通的 **Markdown 文件**，可以和 [[Obsidian 兼容性]] 一起使用。

## 今日任务

- [x] 搭好三栏布局
- [x] 自动保存，显示 *已保存*
- [ ] 写阶段 2 的同步引擎

## 引用与代码

> 好的工具让人忘记它的存在。

\`\`\`go
func main() {
	fmt.Println("hello, lode")
}
\`\`\`

行内代码 \`pnpm build\`，链接到 [[不存在的笔记]]，标签 #灵感
`

async function seed(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  const tree = await (await page.request.get('/api/tree')).json()
  if (tree.notes.some((n: { path: string }) => n.path === '欢迎使用 Lode.md')) return
  const notes: [string, string][] = [
    ['欢迎使用 Lode.md', DEMO],
    ['Obsidian 兼容性.md', '指向 [[欢迎使用 Lode]] 的说明。\n\n文件就是真相源。'],
    ['项目/阶段计划.md', '# 阶段计划\n\n参见 [[欢迎使用 Lode]]。 #项目/lode'],
    ['项目/会议记录.md', '# 周会\n\n- 讨论同步方案\n- 确认设计 tokens'],
    ['读书/设计心理学.md', '> 好的设计是看不见的。\n\n#读书'],
    ['日记/2026-11-07.md', '今天完成了阶段 1。 #写作'],
  ]
  for (const [path, content] of notes) {
    const res = await page.request.post('/api/notes', { data: { path, content } })
    expect(res.ok()).toBe(true)
  }
}

for (const scheme of ['light', 'dark'] as const) {
  for (const size of ['desktop', 'mobile'] as const) {
    test(`截图 ${size} ${scheme}`, async ({ browser }) => {
      mkdirSync(outDir, { recursive: true })
      const ctx = await browser.newContext({
        colorScheme: scheme,
        locale: 'zh-CN',
        ...(size === 'desktop'
          ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
          : { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }),
      })
      const page = await ctx.newPage()
      await seed(page)
      const tree = await (await page.request.get('/api/tree')).json()
      const demo = tree.notes.find((n: { path: string }) => n.path === '欢迎使用 Lode.md')
      await page.goto('/')
      await page.evaluate(() => localStorage.setItem('lode.expanded', JSON.stringify(['项目'])))
      await page.goto(`/note/${demo.id}`)
      await expect(page.locator('.cm-content')).toContainText('今日任务')
      // 让光标离开正文，展示实时预览效果
      await page.locator('.cm-content').evaluate((el) => (el as HTMLElement).blur())
      await page.mouse.click(5, 5)
      await page.waitForTimeout(400)
      await page.screenshot({ path: resolve(outDir, `${size}-${scheme}.png`) })
      if (size === 'mobile') {
        await page.getByRole('button', { name: '返回' }).click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: resolve(outDir, `${size}-${scheme}-list.png`) })
      }
      await ctx.close()
    })
  }
}

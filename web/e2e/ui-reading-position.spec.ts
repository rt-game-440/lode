import { type Page, expect, test } from '@playwright/test'

// #71 打开笔记时回到上次的浏览位置：切换笔记、刷新后恢复滚动；编辑模式恢复光标但不抢焦点（手机宽度不弹键盘）；
// 点大纲跳转以目标位置为准；记录超出文档长度时不报错；不同工作空间的记录互不影响与 200 篇淘汰由单测覆盖（scrollMemory.test）。
// 文件名排在 smoke 之后、ui-workspaces 之前；不新建工作空间。
const PASSWORD = 'e2e-test-password'
const TOLERANCE = 12

test.describe.configure({ mode: 'serial' })

let page: Page
let longId = ''
let otherId = ''

const longContent = () =>
  Array.from({ length: 160 }, (_, i) => (i % 40 === 0 ? `## 小节${i / 40 + 1}\n\n` : '') + `第 ${i + 1} 段：${'这是一段用来撑高文档的正文内容，'.repeat(3)}\n`).join('\n')

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  const make = async (path: string, content: string) => {
    const r = await page.request.post('/api/notes', { data: { path, content } })
    expect(r.ok()).toBe(true)
    return (await r.json()).id as string
  }
  longId = await make('阅读位置长文.md', longContent())
  otherId = await make('阅读位置短文.md', '很短的一篇')
})

test.afterAll(async () => {
  await page.close()
})

const top = () => page.locator('.editor-scroll').evaluate((el) => Math.round(el.scrollTop))
const setTop = (n: number) => page.locator('.editor-scroll').evaluate((el, v) => (el.scrollTop = v), n)
const record = () =>
  page.evaluate((id) => {
    const list = JSON.parse(localStorage.getItem('lode.readpos') ?? '[]') as [string, { topPos: number; offset: number; head: number }][]
    return list.find((e) => e[0] === id)?.[1] ?? null
  }, longId)
const treeItem = (name: string) => page.getByRole('tree').getByRole('treeitem', { name })
const waitStable = () => page.waitForTimeout(700)

/**
 * 当前视口顶端看到的是哪一行、离顶多远。CodeMirror 对没渲染过的部分用估算高度，同一位置的像素 scrollTop
 * 在两次载入间可以不同，所以按“顶端是哪一行 + 行内偏移”比较，这才是用户看到的位置。
 */
const view = async (p: Page) => {
  await expect.poll(() => p.evaluate(() => document.querySelectorAll(".cm-line").length)).toBeGreaterThan(0)
  return viewNow(p)
}
const viewNow = (p: Page) =>
  p.evaluate(() => {
    const el = document.querySelector('.editor-scroll')!
    const top = el.getBoundingClientRect().top
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().bottom > top) ?? document.querySelector('.cm-line')!
    return { text: line.textContent ?? '', off: Math.round(line.getBoundingClientRect().top - top), scroll: Math.round(el.scrollTop) }
  })
function expectSameView(after: Awaited<ReturnType<typeof view>>, before: Awaited<ReturnType<typeof view>>) {
  expect(before.scroll).toBeGreaterThan(1000)
  expect(after.text).toBe(before.text)
  expect(Math.abs(after.off - before.off)).toBeLessThanOrEqual(TOLERANCE)
}

test('滚到中间 → 打开另一篇 → 回到原笔记，滚动位置一致', async () => {
  await page.goto(`/note/${longId}`)
  await expect(page.locator('.cm-line').first()).toBeVisible()
  await setTop(2600)
  await expect.poll(top).toBeGreaterThan(2000)
  await page.waitForTimeout(300)
  const before = await view(page)
  await page.waitForTimeout(400)
  await treeItem('阅读位置短文').click()
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置短文')
  expect(await top()).toBe(0)
  await treeItem('阅读位置长文').click()
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置长文')
  await waitStable()
  expectSameView(await view(page), before)
})

test('刷新页面后重新打开同一篇，位置仍恢复', async () => {
  const before = await view(page)
  await page.waitForTimeout(400)
  await page.goto(`/note/${otherId}`)
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置短文')
  await page.reload()
  await page.goto(`/note/${longId}`)
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置长文')
  await waitStable()
  expectSameView(await view(page), before)
})

test('编辑模式下光标位置恢复（桌面聚焦在记录的行）', async () => {
  await page.goto(`/note/${longId}`)
  await waitStable()
  await setTop(1e6)
  await page.waitForTimeout(400)
  await page.locator('.cm-line', { hasText: '第 159 段' }).first().click()
  await page.waitForTimeout(500)
  const rec = await record()
  expect(rec).not.toBeNull()
  await page.goto(`/note/${otherId}`)
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置短文')
  await page.goto(`/note/${longId}`)
  await waitStable()
  const line = await page.evaluate(() => {
    const node = getSelection()?.anchorNode
    const el = node instanceof Element ? node : node?.parentElement
    return el?.closest('.cm-line')?.textContent ?? ''
  })
  expect(line).toContain('第 159 段')
  await expect(page.locator('.cm-line', { hasText: '第 159 段' }).first()).toBeInViewport()
})

test('点大纲跳转以目标位置为准，不被恢复的位置盖掉', async () => {
  await page.goto(`/note/${otherId}`)
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置短文')
  await treeItem('阅读位置长文').click()
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置长文')
  // 刚打开、恢复校正还没结束时立刻点大纲里的第一个小节
  await page.getByRole('tab', { name: '大纲' }).click()
  await page.getByRole('list', { name: '大纲' }).getByRole('button', { name: '小节1' }).click()
  await waitStable()
  await expect(page.locator('.cm-line', { hasText: '小节1' }).first()).toBeInViewport()
  expect(await top()).toBeLessThan(400)
})

test('记录的位置超出文档长度时不报错，退到文末', async () => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // 先离开长文（离开时会写入它当前的位置），再改写记录
  await page.goto(`/note/${otherId}`)
  await expect(page.getByTestId('note-title')).toHaveText('阅读位置短文')
  await page.evaluate(
    (id) => localStorage.setItem('lode.readpos', JSON.stringify([[id, { topPos: 9999999, offset: 5, head: 9999999 }]])),
    longId,
  )
  await page.goto(`/note/${longId}`)
  await waitStable()
  await expect(page.locator('.cm-line', { hasText: '第 160 段' }).first()).toBeInViewport()
  expect(errors).toEqual([])
})

test('手机宽度：恢复滚动位置，但不聚焦编辑器（不弹键盘）', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, storageState: await page.context().storageState() })
  const m = await ctx.newPage()
  await m.goto(`/note/${longId}`)
  await expect(m.locator('.cm-line').first()).toBeVisible()
  await m.locator('.editor-scroll').evaluate((el) => (el.scrollTop = 2400))
  await m.waitForTimeout(500)
  const before = await view(m)
  await m.goto(`/note/${otherId}`)
  await expect(m.getByTestId('note-title')).toHaveText('阅读位置短文')
  await m.goto(`/note/${longId}`)
  await expect(m.getByTestId('note-title')).toHaveText('阅读位置长文')
  await m.waitForTimeout(700)
  expectSameView(await view(m), before)
  expect(await m.evaluate(() => !!document.activeElement?.closest('.cm-content'))).toBe(false)
  await expect(m.locator('.cm-focused')).toHaveCount(0)
  await ctx.close()
})

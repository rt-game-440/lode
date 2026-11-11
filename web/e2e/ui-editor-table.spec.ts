import { type Page, expect, test } from '@playwright/test'

// 编辑器里的 GFM 表格：光标不在表格时渲染成 <table>，点击单元格切回源码，离开后重新渲染。
// 文件名排在 smoke 之后、visual 之前。
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'zh-CN' })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
})

test.afterAll(async () => {
  await page.close()
})

async function makeNote(path: string, content: string): Promise<string> {
  const r = await page.request.post('/api/notes', { data: { path, content } })
  expect(r.ok()).toBe(true)
  return (await r.json()).id as string
}

const BODY = [
  '| 名称 | 数量 | 说明 |',
  '|:--|:-:|--:|',
  '| 苹果 | **3** | `kg` |',
  '| 梨 | 5 | [[a-tbl-target]] |',
  '',
  '尾段文字',
].join('\n')

test('表格渲染成 table：表头、单元格、对齐、行内格式', async () => {
  await makeNote('a-tbl-target.md', '目标')
  const id = await makeNote('a-tbl-render.md', BODY)
  await page.goto(`/note/${id}`)
  const table = page.locator('.cm-table-widget table')
  await expect(table).toBeVisible()
  await expect(table.locator('th')).toHaveText(['名称', '数量', '说明'])
  await expect(table.locator('tbody td')).toHaveCount(6)
  await expect(table.locator('td strong')).toHaveText('3')
  await expect(table.locator('td code')).toHaveText('kg')
  await expect(table.locator('th').nth(1)).toHaveCSS('text-align', 'center')
  await expect(table.locator('th').nth(2)).toHaveCSS('text-align', 'right')
  // 源码里的竖线和分隔行不应该出现在页面上
  await expect(page.locator('.cm-content')).not.toContainText('|:--|')
})

test('点击单元格切到源码，点表格外又渲染；编辑后渲染内容同步', async () => {
  const id = await makeNote('a-tbl-edit.md', BODY)
  await page.goto(`/note/${id}`)
  const widget = page.locator('.cm-table-widget')
  await expect(widget).toBeVisible()

  await widget.locator('td', { hasText: '苹果' }).click()
  await expect(widget).toHaveCount(0)
  await expect(page.locator('.cm-table-raw')).toHaveCount(4)
  await expect(page.locator('.cm-content')).toContainText('|:--|:-:|--:|')

  // 光标落在被点的单元格里：直接输入会改到“苹果”
  await page.keyboard.type('新')
  await page.locator('.cm-line', { hasText: '尾段文字' }).click()
  await expect(widget).toBeVisible()
  await expect(widget.locator('td').first()).toHaveText(/新/)
  await expect(page.locator('.cm-table-raw')).toHaveCount(0)
})

test('方向键从表格上方的段落移进表格时也切到源码', async () => {
  const id = await makeNote('a-tbl-arrow.md', `前言\n\n${BODY}`)
  await page.goto(`/note/${id}`)
  await expect(page.locator('.cm-table-widget')).toBeVisible()
  await page.locator('.cm-line', { hasText: '前言' }).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cm-table-raw').first()).toBeVisible()
})

test('单元格里的 wikilink 单击即打开目标笔记', async () => {
  const id = await makeNote('a-tbl-link.md', BODY)
  await page.goto(`/note/${id}`)
  const link = page.locator('.cm-table-widget .cm-wikilink')
  await expect(link).toHaveText('a-tbl-target')
  await expect(link).not.toHaveClass(/cm-wikilink-missing/)
  await link.click()
  await expect(page).not.toHaveURL(new RegExp(`/note/${id}`))
  await expect(page.locator('.cm-content')).toContainText('目标')
})

test('手机宽度：宽表格在表格内横向滚动，页面不横向溢出', async () => {
  const cols = Array.from({ length: 12 }, (_, i) => `很长的列名${i}`)
  const wide = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, `| ${cols.map((_, i) => `内容内容${i}`).join(' | ')} |`].join('\n')
  const id = await makeNote('a-tbl-wide.md', wide)
  await page.setViewportSize({ width: 390, height: 780 })
  try {
    await page.goto(`/note/${id}`)
    const scroll = page.locator('.cm-table-scroll')
    await expect(scroll).toBeVisible()
    const m = await scroll.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, doc: document.documentElement.scrollWidth, win: window.innerWidth }))
    expect(m.sw).toBeGreaterThan(m.cw)
    expect(m.doc).toBeLessThanOrEqual(m.win)
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 })
  }
})

test('没有表格的笔记不受影响：竖线文字保持原样', async () => {
  const id = await makeNote('a-tbl-none.md', '# 标题\n\n这行有 | 竖线 | 但不是表格\n\n- 列表项')
  await page.goto(`/note/${id}`)
  await expect(page.locator('.cm-content')).toContainText('这行有 | 竖线 | 但不是表格')
  await expect(page.locator('.cm-table-widget')).toHaveCount(0)
})

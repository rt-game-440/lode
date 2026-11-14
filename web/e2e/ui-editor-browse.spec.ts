import { type Page, expect, test } from '@playwright/test'

// 笔记页“仅浏览”模式：顶栏按钮、Ctrl+Shift+E、设置里的默认开关。
// 浏览时正文和标题不可改、不弹键盘；表格渲染、链接点击、任务勾选照常。
// 文件名排在 ui-editor-table 之后、visual 之前；笔记名用 a- 前缀，保证排在中文笔记前面。
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
  '# 仅浏览',
  '',
  '正文第一段',
  '',
  '| 名称 | 数量 |',
  '|---|---|',
  '| 苹果 | [[a-brw-target]] |',
  '',
  '- [ ] 任务甲',
  '- [ ] 任务乙',
  '',
  '尾段文字',
].join('\n')

test('顶栏按钮切换仅浏览：正文和标题不可改，切回编辑后可以改', async () => {
  await makeNote('a-brw-target.md', '目标')
  const id = await makeNote('a-brw-toggle.md', BODY)
  await page.goto(`/note/${id}`)
  const content = page.locator('.cm-content')
  const toggle = page.getByTestId('browse-toggle')
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(content).toHaveAttribute('contenteditable', 'false')
  await expect(page.getByTestId('note-title')).toHaveAttribute('aria-disabled', 'true')
  await page.getByTestId('note-title').click({ force: true })
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveCount(0)
  await expect(page.getByTestId('format-toolbar')).toHaveCount(0)
  // 点正文再输入：内容不变
  await page.locator('.cm-line', { hasText: '正文第一段' }).click()
  await page.keyboard.type('不应出现')
  await expect(content).not.toContainText('不应出现')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await page.locator('.cm-line', { hasText: '尾段文字' }).click()
  await page.keyboard.type('改动')
  await expect(content).toContainText('改动')
})

test('仅浏览时表格保持渲染、点单元格不切源码，单元格里的链接照常打开', async () => {
  const id = await makeNote('a-brw-links.md', BODY)
  await page.goto(`/note/${id}`)
  await page.getByTestId('browse-toggle').click()
  const widget = page.locator('.cm-table-widget')
  await expect(widget).toBeVisible()
  await widget.locator('td', { hasText: '苹果' }).click()
  await expect(page.locator('.cm-table-raw')).toHaveCount(0)
  await expect(widget).toBeVisible()
  await widget.locator('.cm-wikilink').click()
  await expect(page).not.toHaveURL(new RegExp(`/note/${id}`))
  await expect(page.locator('.cm-content')).toContainText('目标')
})

test('仅浏览时任务复选框仍可勾选，并保存', async () => {
  const id = await makeNote('a-brw-task.md', BODY)
  await page.goto(`/note/${id}`)
  await page.getByTestId('browse-toggle').click()
  const box = page.locator('.cm-task-checkbox').first()
  await expect(box).toBeVisible()
  await box.click()
  await expect(box).toBeChecked()
  await expect(page.getByTestId('save-status')).toContainText('已保存')
  await page.reload()
  await expect(page.locator('.cm-task-checkbox').first()).toBeChecked()
})

test('设置里打开“默认仅浏览”后，打开笔记直接是仅浏览；关闭后恢复编辑', async () => {
  const a = await makeNote('a-brw-default-a.md', '第一篇')
  const b = await makeNote('a-brw-default-b.md', '第二篇')
  await page.goto('/settings/editor')
  const sw = page.getByTestId('browse-default-switch')
  await expect(sw).not.toBeChecked()
  await sw.check()
  try {
    await page.goto(`/note/${a}`)
    await expect(page.getByTestId('browse-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
    await page.goto(`/note/${b}`)
    await expect(page.getByTestId('browse-toggle')).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await page.goto('/settings/editor')
    await page.getByTestId('browse-default-switch').uncheck()
  }
  await page.goto(`/note/${a}`)
  await expect(page.getByTestId('browse-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
})

test('Ctrl+Shift+E 在笔记页切换仅浏览，编辑器有焦点时同样有效', async () => {
  const id = await makeNote('a-brw-key.md', BODY)
  await page.goto(`/note/${id}`)
  const toggle = page.getByTestId('browse-toggle')
  await page.locator('.cm-line', { hasText: '正文第一段' }).click()
  await page.keyboard.press('Control+Shift+E')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  await page.keyboard.press('Control+Shift+E')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('手机宽度：仅浏览时点正文不弹出底部工具栏，切回编辑后再点才弹出', async () => {
  const id = await makeNote('a-brw-mobile.md', BODY)
  await page.setViewportSize({ width: 390, height: 780 })
  try {
    await page.goto(`/note/${id}`)
    await page.getByTestId('browse-toggle').click()
    await page.locator('.cm-line', { hasText: '正文第一段' }).click()
    await expect(page.getByTestId('mobile-toolbar')).toHaveCount(0)
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

    await page.getByTestId('browse-toggle').click()
    await page.locator('.cm-line', { hasText: '正文第一段' }).click()
    await expect(page.getByTestId('mobile-toolbar')).toBeVisible()
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 })
  }
})

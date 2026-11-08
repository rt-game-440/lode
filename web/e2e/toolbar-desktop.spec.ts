import { type Page, expect, test } from '@playwright/test'

// 桌面格式顶栏。文件名排在 smoke.spec 之后（smoke 负责首次设置密码）、touch/visual 之前。
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page
let noteUrl = ''

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext()
  const status = await (await ctx.request.get('/api/auth/status')).json()
  if (!status.initialized) await ctx.request.post('/api/auth/setup', { data: { password: PASSWORD } })
  else await ctx.request.post('/api/auth/login', { data: { password: PASSWORD } })
  page = await ctx.newPage()
})

test.afterAll(async () => {
  await page.context().close()
})

const toolbar = () => page.getByRole('toolbar', { name: '格式' })
const text = () => page.locator('.cm-content').evaluate((el) => (el as HTMLElement).innerText)

test('桌面显示格式顶栏，按钮作用于选区且提示带快捷键', async () => {
  await page.goto('/')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Enter')
  await page.locator('.cm-content').click()
  noteUrl = page.url()
  await expect(toolbar()).toBeVisible()
  await expect(page.getByRole('toolbar', { name: '插入 Markdown' })).toHaveCount(0)

  await expect(toolbar().getByRole('button', { name: '加粗' })).toHaveAttribute('title', /Ctrl\+B|⌘B/)
  await expect(toolbar().getByRole('button', { name: '引用' })).toHaveAttribute('title', /U/)

  await page.keyboard.type('hello')
  await page.keyboard.press('Shift+Home')
  await toolbar().getByRole('button', { name: '加粗' }).click()
  await expect.poll(text).toContain('**hello**')
  await expect(page.locator('.cm-content')).toBeFocused()

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('quote')
  await toolbar().getByRole('button', { name: '引用' }).click()
  await expect.poll(text).toContain('> quote')

  // 快捷键与按钮等效
  await page.keyboard.type(' x')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Control+e')
  await expect.poll(text).toContain('`')
})

test('设置里可以隐藏和重新显示，刷新后保持', async () => {
  await page.goto('/settings/editor')
  const sw = page.getByTestId('format-toolbar-switch')
  await expect(sw).toBeChecked()
  await sw.uncheck()
  await page.reload()
  await expect(page.getByTestId('format-toolbar-switch')).not.toBeChecked()
  await page.goto(noteUrl)
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(toolbar()).toHaveCount(0)

  await page.goto('/settings/editor')
  await page.getByTestId('format-toolbar-switch').check()
  await page.goto(noteUrl)
  await expect(toolbar()).toBeVisible()
})

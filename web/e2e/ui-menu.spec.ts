import { type Page, expect, test } from '@playwright/test'

// 笔记标题栏“更多操作”菜单（issue #17）：点菜单外部、按 Esc、再次点击 … 按钮都能关闭；
// 关闭后焦点回到 … 按钮。文件名排在 touch.spec 之后、visual.spec 之前。
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page
let noteId = ''

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'zh-CN' })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  const res = await page.request.post('/api/notes', {
    data: { path: '菜单/关闭方式.md', content: '# 关闭方式\n\n用于验证更多操作菜单的关闭方式。' },
  })
  expect(res.ok()).toBe(true)
  noteId = (await res.json()).id
})

test.afterAll(async () => {
  await page.close()
})

const moreButton = () => page.getByRole('button', { name: '更多操作' })
const menu = () => page.getByRole('menu')

async function openMoreMenu() {
  await page.goto(`/note/${noteId}`)
  await expect(page.getByLabel('笔记标题')).toBeVisible()
  await moreButton().click()
  await expect(menu()).toBeVisible()
}

test('点击菜单外部关闭，且这次点击不触发被点到的元素', async () => {
  await openMoreMenu()
  // 用右栏开关作为“被点到的元素”：外部点击若被放行，它的 aria-label 会在 显示/隐藏 之间切换
  const rightToggle = page.getByRole('button', { name: /^(隐藏|显示)右栏$/ })
  const before = await rightToggle.getAttribute('aria-label')
  await rightToggle.click()
  await expect(menu()).toBeHidden()
  await expect(rightToggle).toHaveAttribute('aria-label', before ?? '')
})

test('按 Esc 关闭菜单，焦点回到 … 按钮', async () => {
  await openMoreMenu()
  await page.keyboard.press('Escape')
  await expect(menu()).toBeHidden()
  await expect(moreButton()).toBeFocused()
})

test('再次点击 … 按钮关闭菜单，且不会立刻重新打开', async () => {
  await openMoreMenu()
  await moreButton().click()
  await expect(menu()).toBeHidden()
  // 给重新打开留出时间：若又打开了，菜单会在这段时间内出现
  await page.waitForTimeout(400)
  await expect(menu()).toBeHidden()
})

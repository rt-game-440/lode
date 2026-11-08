import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// 退出登录确认对话框（issue #24）。只使用本地测试实例的测试密码。
// 不做首启设置：smoke 先跑并完成设置；本 spec 在 beforeAll 里按状态决定 setup 或 login。
const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')
const PASSWORD = 'e2e-test-password'
const NOTE_TITLE = '退出确认测试'
const BODY = '离线时写下的正文，退出后应保留并在重新登录后同步。'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/')
  // 在页面上下文里请求，保证 cookie 落在 page 所在的浏览上下文中
  const initialized = await page.evaluate(async () => {
    const body = (await (await fetch('/api/auth/status')).json()) as { initialized: boolean }
    return body.initialized
  })
  const path = initialized ? '/api/auth/login' : '/api/auth/setup'
  const res = await page.evaluate(
    async ({ path, password }) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).status,
    { path, password: PASSWORD },
  )
  expect(res).toBeLessThan(300)
  await page.reload()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
})

test.afterAll(async () => {
  await page.close()
})

const logoutButton = () => page.getByRole('button', { name: '退出登录', exact: true })
const dialog = () => page.getByRole('dialog', { name: '退出登录？' })

async function loginViaForm() {
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('点击退出登录先弹出确认框，默认焦点在取消', async () => {
  await logoutButton().click()
  await expect(dialog()).toBeVisible()
  await expect(dialog().getByText('退出后需要重新输入密码。')).toBeVisible()
  await expect(dialog().getByRole('button', { name: '取消' })).toBeFocused()
  // 无未同步修改时不出现额外提示
  await expect(dialog().getByText('未同步')).toHaveCount(0)
})

test('取消不会退出', async () => {
  await dialog().getByRole('button', { name: '取消' }).click()
  await expect(dialog()).toHaveCount(0)
  await expect(logoutButton()).toBeVisible()
})

test('按 Esc 关闭确认框且不会退出', async () => {
  await logoutButton().click()
  await expect(dialog()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(logoutButton()).toBeVisible()
})

test('确认后退出并回到登录页，重新输入密码可登录', async () => {
  await logoutButton().click()
  await dialog().getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
  await loginViaForm()
  await expect(logoutButton()).toBeVisible()
})

test('有未同步修改时提示会保留在本机，重新登录后同步到磁盘', async () => {
  // 笔记路径带专用标题，避免与其他 spec 的笔记冲突
  await page.getByTestId('new-note').click()
  await page.getByLabel('笔记标题').fill(NOTE_TITLE)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('treeitem', { name: NOTE_TITLE })).toBeVisible()

  await page.context().setOffline(true)
  await page.locator('.cm-content').click()
  await page.keyboard.type(BODY)
  await expect(page.getByText(/项待同步/)).toBeVisible()

  await logoutButton().click()
  await expect(dialog().getByText(/未同步的修改/)).toBeVisible()
  await expect(dialog().getByText(/保留在本机/)).toBeVisible()
  await dialog().getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录 Lode' })).toBeVisible()

  await page.context().setOffline(false)
  await loginViaForm()
  // 重新登录后仍停留在刚才的笔记上，侧栏可见即说明已回到应用
  await expect(logoutButton()).toBeVisible()
  await expect
    .poll(() => {
      const file = join(vault, `${NOTE_TITLE}.md`)
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    })
    .toBe(BODY)
})

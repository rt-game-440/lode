import { join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { type Page, expect, test } from '@playwright/test'

// 退出登录确认对话框（issue #24）。只使用本地测试实例的测试密码。
const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')
const PASSWORD = 'e2e-test-password'
const BODY = '离线时写下的正文，退出后应保留并在重新登录后同步。'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

const logoutButton = () => page.getByRole('button', { name: '退出登录', exact: true })
const dialog = () => page.getByRole('dialog', { name: '退出登录？' })

test('首启设置密码后进入应用', async () => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByLabel('确认密码').fill(PASSWORD)
  await page.getByRole('button', { name: '设置密码并进入' }).click()
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()
})

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
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()
})

test('按 Esc 关闭确认框且不会退出', async () => {
  await logoutButton().click()
  await expect(dialog()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()
})

test('确认后退出并回到登录页，重新输入密码可登录', async () => {
  await logoutButton().click()
  await dialog().getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()
})

test('有未同步修改时提示会保留在本机，重新登录后同步到磁盘', async () => {
  await page.getByTestId('new-note').click()
  await page.getByLabel('笔记标题').fill('退出测试')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('treeitem', { name: '退出测试' })).toBeVisible()

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
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  // 重新登录后仍停留在刚才的笔记上，侧栏可见即说明已回到应用
  await expect(logoutButton()).toBeVisible()
  await expect
    .poll(() => {
      const file = join(vault, '退出测试.md')
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    })
    .toBe(BODY)
})

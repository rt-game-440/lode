import { type Page, expect, test } from '@playwright/test'

// 针对已部署实例（Docker 容器等）的冒烟：只通过 HTTP 访问，不读写数据目录。
// 只在设置了 LODE_E2E_URL 时运行，且实例必须是全新的（尚未设置密码）：
//   LODE_E2E_URL=http://127.0.0.1:8787 pnpm -C web e2e container
test.skip(!process.env.LODE_E2E_URL, '需要设置 LODE_E2E_URL 指向一个全新的实例')
test.describe.configure({ mode: 'serial' })

// 只在测试实例里使用的测试密码
const PASSWORD = 'e2e-test-password'
let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

test('健康检查和安全响应头', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBe(true)
  expect((await health.json()).status).toBe('ok')
  const index = await request.get('/')
  const h = index.headers()
  expect(h['content-security-policy']).toContain("script-src 'self'")
  expect(h['x-content-type-options']).toBe('nosniff')
  expect(h['referrer-policy']).toBeTruthy()
})

test('首启设置密码、新建笔记、保存、刷新、搜索', async () => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '欢迎使用 Lode' })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByLabel('确认密码').fill(PASSWORD)
  await page.getByRole('button', { name: '设置密码并进入' }).click()
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()

  await page.getByTestId('new-note').click()
  await expect(page.getByLabel('笔记标题')).toBeFocused()
  await page.keyboard.type('容器冒烟')
  await page.keyboard.press('Enter')
  const body = '部署后的全文搜索冒烟测试。'
  await page.locator('.cm-content').click()
  await page.keyboard.type(body)
  await expect(page.getByTestId('save-status')).toHaveText('已保存')

  await page.reload()
  await expect(page.locator('.cm-content')).toHaveText(body)
  await page.getByRole('tab', { name: '搜索' }).click()
  await page.getByLabel('搜索全部笔记').fill('全文搜索')
  await expect(page.getByRole('listitem').filter({ hasText: '容器冒烟' })).toBeVisible()
  // CSP 不应拦下任何资源（被拦截时浏览器在控制台报错）
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([])
})

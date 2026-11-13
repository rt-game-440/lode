import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, type BrowserContext, type Page, expect, test } from '@playwright/test'

// 阶段 4：设置页的 API token 管理与 MCP 调用记录（#23 起分在设置的“MCP 接入”“API token”“调用记录”子页面）。
// 文件名排在 smoke.spec 之后：smoke 的第一个用例要求实例尚未设置密码。
// 只在本地测试实例里使用的测试密码
const PASSWORD = 'e2e-test-password'

// 设置 LODE_SCREENSHOTS=stage-4 时在关键状态截图，输出到 docs/screenshots/stage-4/
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(300)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

let ctx: BrowserContext
let page: Page
let secret = ''

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

let rpcId = 0
/** 用 Bearer token 直接发 MCP 的 JSON-RPC 请求（无状态服务，不需要先 initialize）。 */
async function mcp(request: APIRequestContext, token: string, method: string, params: object) {
  return request.post('/mcp', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: ++rpcId, method, params },
  })
}

async function callTool(request: APIRequestContext, token: string, name: string, args: object) {
  const res = await mcp(request, token, 'tools/call', { name, arguments: args })
  expect(res.status()).toBe(200)
  const body = await res.json()
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text as string }
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  await signIn(ctx)
  page = await ctx.newPage()
})

test.afterAll(async () => {
  await ctx.close()
})

test('设置页创建读写 token：明文只显示一次，可以复制', async () => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('link', { name: /^MCP 接入/ }).click()
  await expect(page).toHaveURL(/\/settings\/mcp$/)
  await expect(page.getByTestId('mcp-endpoint')).toHaveText(new URL('/mcp', page.url()).href)
  await page.getByRole('button', { name: '返回设置' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('link', { name: /^API token/ }).click()
  await expect(page).toHaveURL(/\/settings\/tokens$/)

  // 不填名称直接创建：提示填写
  await page.getByRole('button', { name: '创建 token' }).click()
  await expect(page.getByRole('alert')).toContainText('请填写名称')

  await page.getByLabel('名称').fill('Playwright')
  await page.getByRole('radio', { name: '读写' }).click()
  await expect(page.getByRole('radio', { name: '读写' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: '创建 token' }).click()

  const shown = page.getByTestId('token-secret')
  await expect(shown).toHaveText(/^lode_[\w-]{43}$/)
  secret = (await shown.textContent()) ?? ''
  await shot(page, '4-1-token-created')

  await page.getByRole('button', { name: '复制token' }).click()
  await expect(page.getByText('已复制token')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)

  await page.getByRole('button', { name: '我已保存' }).click()
  await expect(shown).toHaveCount(0)
  const row = page.getByRole('list', { name: 'API token 列表' }).getByRole('listitem').filter({ hasText: 'Playwright' })
  await expect(row).toContainText('读写')
  await expect(row).toContainText('从未使用')
  // 列表和刷新后的页面都不再出现明文；刷新后仍停在 API token 页面
  await page.reload()
  await expect(page.getByRole('heading', { name: 'API token', level: 1 })).toBeVisible()
  await expect(page.getByText(secret)).toHaveCount(0)
})

test('MCP 追加一行：打开的笔记无需刷新即可看到，调用记录里有这次调用', async () => {
  const created = await ctx.request.post('/api/notes', { data: { path: 'MCP/收件箱.md', content: '# 收件箱\n\n- 第一条\n' } })
  expect(created.ok()).toBe(true)
  const note = await created.json()

  const viewer = await ctx.newPage()
  await viewer.goto(`/note/${note.id}`)
  await expect(viewer.locator('.cm-content')).toContainText('第一条')

  const found = await callTool(ctx.request, secret, 'search_notes', { query: '第一条' })
  expect(found.isError).toBe(false)
  expect(JSON.parse(found.text).results[0].path).toBe('MCP/收件箱.md')
  const read = JSON.parse((await callTool(ctx.request, secret, 'read_note', { path: 'MCP/收件箱.md' })).text)
  const appended = await callTool(ctx.request, secret, 'update_note', {
    path: 'MCP/收件箱.md',
    base_rev: read.rev,
    mode: 'append',
    content: '- 来自 MCP 的一行',
  })
  expect(appended.isError).toBe(false)
  await expect(viewer.locator('.cm-content')).toContainText('来自 MCP 的一行')
  await viewer.close()

  const missing = await callTool(ctx.request, secret, 'read_note', { path: '不存在.md' })
  expect(missing.isError).toBe(true)

  await page.getByRole('button', { name: '返回设置' }).click()
  await page.getByRole('link', { name: /^调用记录/ }).click()
  await expect(page).toHaveURL(/\/settings\/audit$/)
  await page.getByRole('button', { name: '刷新调用记录' }).click()
  const rows = page.getByRole('table', { name: '调用记录' }).getByRole('row')
  await expect(rows.filter({ hasText: 'update_note' })).toContainText('MCP/收件箱.md')
  await expect(rows.filter({ hasText: 'update_note' })).toContainText('成功')
  await expect(rows.filter({ hasText: 'update_note' })).toContainText('Playwright')
  await expect(rows.filter({ hasText: '不存在.md' })).toContainText('失败')
  await expect(rows.filter({ hasText: '不存在.md' })).toContainText('找不到')
  await expect(rows.filter({ hasText: '第一条' })).toContainText('search_notes')
  if (shotDir) {
    await page.getByRole('table', { name: '调用记录' }).scrollIntoViewIfNeeded()
    await shot(page, '4-2-audit-log')
    await page.setViewportSize({ width: 390, height: 844 })
    // 切到手机布局会重新挂载设置页：等布局稳定、调用记录重新加载出来，再滚到底部
    await page.waitForTimeout(500)
    await expect(page.getByRole('table', { name: '调用记录' })).toBeVisible()
    await page.getByTestId('audit-page').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await shot(page, '4-3-settings-mobile')
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  // 浏览器后退回到设置首页，再进 API token：最后使用时间已更新
  await page.goBack()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('link', { name: /^API token/ }).click()
  await expect(page.getByRole('list', { name: 'API token 列表' }).getByRole('listitem').filter({ hasText: 'Playwright' })).not.toContainText(
    '从未使用',
  )
})

test('在 token 详情页吊销后返回列表，MCP 请求返回 401', async () => {
  const row = page.getByRole('list', { name: 'API token 列表' }).getByRole('listitem').filter({ hasText: 'Playwright' })
  await row.getByRole('link').click()
  await expect(page).toHaveURL(/\/settings\/tokens\/[^/]+$/)
  const detail = page.getByTestId('token-detail')
  await expect(detail).toContainText('读写')
  // 详情页列出这个 token 的调用
  await expect(detail.getByRole('table')).toContainText('update_note')
  await detail.getByRole('button', { name: '吊销' }).click()
  // 设置浮窗里再弹出确认框：两个 dialog，按名称取确认框
  await page.getByRole('dialog', { name: /吊销/ }).getByRole('button', { name: '吊销' }).click()
  await expect(page.getByText('已吊销“Playwright”')).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/tokens$/)
  await expect(row).toHaveCount(0)

  const res = await mcp(ctx.request, secret, 'tools/list', {})
  expect(res.status()).toBe(401)
  expect((await mcp(ctx.request, 'lode_wrong', 'tools/list', {})).status()).toBe(401)
})

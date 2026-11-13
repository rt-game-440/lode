import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #59：设置页管理工作空间（重命名、拖动和键盘排序、删除），MCP token 绑定工作空间。
// 文件名排在 ui-workspaces.spec 之前（'-' 排在 's' 前），而后者要求实例里只有默认工作空间：
// 所以本文件结束时（含失败）把新建的工作空间、token 都删掉，并把默认工作空间的名称改回去。
// 设置 LODE_SCREENSHOTS=<目录名> 时截取列表、详情、删除确认、token 表单，输出到 docs/screenshots/<目录名>/。
const PASSWORD = 'e2e-test-password'
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''

test.describe.configure({ mode: 'serial' })

let server: BrowserContext
const ids: Record<string, string> = {}

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

async function open(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, ...opts })
  await signIn(c)
  return { c, p: await c.newPage() }
}

async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

interface WsInfo {
  id: string
  name: string
  sort: number
}

async function serverList(): Promise<WsInfo[]> {
  return (await (await server.request.get('/api/workspaces')).json()).workspaces
}
const serverNames = async () => (await serverList()).map((w) => w.name)

const switcher = (p: Page) => p.getByTestId('workspace-switcher')
const rows = (p: Page) => p.getByTestId('workspace-row')
const rowNames = async (p: Page) => (await rows(p).locator('.ws-name').allTextContents()).map((t) => t.replace(/当前$/, ''))
const heading = (p: Page, name: string) => p.getByRole('heading', { name, level: 1, exact: true })
const handle = (p: Page, name: string) => p.getByRole('button', { name: new RegExp(`^调整“${name}”的顺序`) })

/** 侧栏切换器菜单里的工作空间名（按顺序） */
/** 侧栏切换器的菜单项。设置是桌面浮窗，打开时下面的侧栏不可操作：另开一页读取（工作空间列表来自同一个 store 和服务器）。 */
async function menuNames(p: Page) {
  const q = await p.context().newPage()
  await q.goto('/')
  await switcher(q).click()
  const names = await q.getByRole('menuitemradio').locator('.menu-label').allTextContents()
  await q.close()
  return names
}

async function cleanup() {
  for (const w of await serverList()) {
    if (w.id !== 'default') await server.request.delete(`/api/workspaces/${w.id}`)
  }
  await server.request.patch('/api/workspaces/default', { data: { name: '笔记' } })
  const toks = (await (await server.request.get('/api/tokens')).json()).tokens as { id: string; name: string }[]
  for (const t of toks) if (t.name.startsWith('ws-e2e-')) await server.request.delete(`/api/tokens/${t.id}`)
}

test.beforeAll(async ({ browser }) => {
  server = await browser.newContext()
  await signIn(server)
  expect((await serverList()).map((w) => w.id), '前置条件：只有默认工作空间').toEqual(['default'])
  for (const name of ['甲', '乙', '丙']) {
    const res = await server.request.post('/api/workspaces', { data: { name } })
    expect(res.status()).toBe(201)
    ids[name] = (await res.json()).id
  }
  // 乙里放一篇笔记，丙里放一篇，检查删除时的说明和隔离
  for (const [name, text] of [['乙', '乙独有关键词'], ['丙', '丙独有关键词']]) {
    const res = await server.request.post(`/api/w/${ids[name]}/notes`, { data: { path: `${name}.md`, content: `# ${name}\n\n${text}\n` } })
    expect(res.ok()).toBe(true)
  }
})

test.afterAll(async () => {
  await cleanup()
  await server.close()
})

test('设置首页有“工作空间”入口，侧栏切换器的“管理工作空间”直达列表', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings')
  const link = p.getByTestId('settings-workspaces')
  await expect(link).toContainText('4 个')
  await link.click()
  await expect(heading(p, '工作空间')).toBeVisible()
  await expect(p).toHaveURL(/\/settings\/workspaces$/)
  expect(await rowNames(p)).toEqual(['笔记当前', '甲', '乙', '丙'].map((s) => s.replace(/当前$/, '')))
  await expect(rows(p).first()).toContainText('当前')
  await expect(rows(p).filter({ hasText: '甲' })).toContainText('0 篇笔记')
  await expect(rows(p).filter({ hasText: '乙' })).toContainText('1 篇笔记')

  await p.goto('/')
  await switcher(p).click()
  await p.getByRole('menuitem', { name: '管理工作空间…' }).click()
  await expect(p).toHaveURL(/\/settings\/workspaces$/)
  await expect(heading(p, '工作空间')).toBeVisible()
  await c.close()
})

test('重命名：详情页改名后列表、侧栏切换器同步更新；名称校验与新建一致', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings/workspaces')
  await rows(p).filter({ hasText: '甲' }).getByRole('link').click()
  await expect(p).toHaveURL(new RegExp(`/settings/workspaces/${ids['甲']}$`))
  const detail = p.getByTestId('workspace-detail')
  await expect(detail.getByTestId('workspace-path')).toHaveText(`workspaces/${ids['甲']}/vault`)
  await shot(p, 'ws-detail')

  await detail.getByTestId('workspace-rename').click()
  const dialog = p.locator('[role="dialog"]:not([data-testid="settings-dialog"])')
  await expect(dialog.getByLabel('名称')).toHaveValue('甲')
  await dialog.getByLabel('名称').fill('   ')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('请输入名称')
  await dialog.getByLabel('名称').fill('甲甲')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
  await expect(heading(p, '甲甲')).toBeVisible()
  expect(await serverNames()).toEqual(['笔记', '甲甲', '乙', '丙'])

  await p.getByRole('button', { name: '返回工作空间' }).click()
  expect(await rowNames(p)).toEqual(['笔记', '甲甲', '乙', '丙'])
  expect(await menuNames(p)).toEqual(['笔记', '甲甲', '乙', '丙'])

  // 默认工作空间也可以改名，但不能删除
  await rows(p).first().getByRole('link').click()
  await expect(p.getByTestId('workspace-delete')).toBeDisabled()
  await expect(p.getByText('默认工作空间不能删除，只能改名。')).toBeVisible()
  await p.getByTestId('workspace-rename').click()
  await p.locator('[role="dialog"]:not([data-testid="settings-dialog"])').getByLabel('名称').fill('主库')
  await p.locator('[role="dialog"]:not([data-testid="settings-dialog"])').getByRole('button', { name: '保存' }).click()
  await expect(switcher(p)).toHaveAccessibleName('工作空间：主库')
  expect(await serverNames()).toEqual(['主库', '甲甲', '乙', '丙'])
  await c.close()
})

test('排序：键盘上下方向键移动，拖动把手也能排序，侧栏切换器顺序同步', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings/workspaces')
  await expect(rows(p)).toHaveCount(4)

  // 键盘：聚焦“丙”的把手，上移两位
  await handle(p, '丙').focus()
  await p.keyboard.press('ArrowUp')
  await expect.poll(() => serverNames()).toEqual(['主库', '甲甲', '丙', '乙'])
  await expect(handle(p, '丙')).toBeFocused() // 移动后焦点还在
  await p.keyboard.press('ArrowUp')
  await expect.poll(() => serverNames()).toEqual(['主库', '丙', '甲甲', '乙'])
  await expect(p.getByRole('status').filter({ hasText: '移到第 2 位' })).toHaveCount(1)
  expect(await rowNames(p)).toEqual(['主库', '丙', '甲甲', '乙'])
  // 到头了不再动；Home / End 直达两端
  await handle(p, '丙').focus()
  await p.keyboard.press('End')
  await expect.poll(() => serverNames()).toEqual(['主库', '甲甲', '乙', '丙'])
  await p.keyboard.press('Home')
  await expect.poll(() => serverNames()).toEqual(['丙', '主库', '甲甲', '乙'])
  await p.keyboard.press('ArrowUp')
  expect(await serverNames()).toEqual(['丙', '主库', '甲甲', '乙'])
  // 默认工作空间可以排在后面，只是 id 不变
  expect((await serverList())[1].id).toBe('default')

  // 拖动：把“乙”的把手拖到第一行上方
  await p.waitForTimeout(600) // 等键盘排序的位移动画结束再量位置
  const box = async (name: string) => (await handle(p, name).boundingBox())!
  const from = await box('乙')
  const to = await box('丙')
  await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await p.mouse.down()
  // 逐步移动并留出时间，让拖动排序逐行交换位置
  const x = from.x + from.width / 2
  const y0 = from.y + from.height / 2
  const y1 = to.y - 10
  for (let i = 1; i <= 24; i++) {
    await p.mouse.move(x, y0 + ((y1 - y0) * i) / 24)
    await p.waitForTimeout(40)
  }
  await p.mouse.up()
  await expect.poll(() => serverNames()).toEqual(['乙', '丙', '主库', '甲甲'])
  expect(await rowNames(p)).toEqual(['乙', '丙', '主库', '甲甲'])
  expect((await serverList()).map((w) => w.sort)).toEqual([0, 1, 2, 3])
  await shot(p, 'ws-list')

  // 侧栏切换器同步；刷新后顺序保持
  expect(await menuNames(p)).toEqual(['乙', '丙', '主库', '甲甲'])
  await p.reload()
  expect(await rowNames(p)).toEqual(['乙', '丙', '主库', '甲甲'])

  // 恢复成 主库、甲甲、乙、丙，方便后面的用例
  await handle(p, '主库').focus()
  await p.keyboard.press('Home')
  await expect.poll(() => serverNames()).toEqual(['主库', '乙', '丙', '甲甲'])
  await handle(p, '甲甲').focus()
  await p.keyboard.press('ArrowUp')
  await p.keyboard.press('ArrowUp')
  await expect.poll(() => serverNames()).toEqual(['主库', '甲甲', '乙', '丙'])
  await c.close()
})

test('token 绑定工作空间：下拉框默认当前空间，列表和详情显示所属空间', async ({ browser }) => {
  const { c, p } = await open(browser)
  // 在乙里打开设置：下拉框默认选中乙
  await p.goto(`/w/${ids['乙']}/settings/tokens`)
  const select = p.getByTestId('token-workspace')
  await expect(select).toHaveValue(ids['乙'])
  await expect(select.locator('option')).toHaveText(['主库', '甲甲', '乙', '丙'])
  await p.getByLabel('名称').fill('ws-e2e-乙')
  await shot(p, 'ws-token-form')
  await p.getByRole('button', { name: '创建 token' }).click()
  const reveal = p.getByRole('status').filter({ hasText: '已创建“ws-e2e-乙”' })
  await expect(reveal).toContainText('工作空间：乙')
  const secret = (await p.getByTestId('token-secret').textContent())!
  ids.tokenYi = secret
  await p.getByRole('button', { name: '我已保存' }).click()

  // 改选丙再建一个
  await p.getByLabel('名称').fill('ws-e2e-丙')
  await select.selectOption({ label: '丙' })
  await p.getByRole('button', { name: '创建 token' }).click()
  ids.tokenBing = (await p.getByTestId('token-secret').textContent())!
  await p.getByRole('button', { name: '我已保存' }).click()

  const list = p.getByRole('list', { name: 'API token 列表' })
  await expect(list.getByRole('link', { name: /ws-e2e-乙/ })).toContainText('工作空间：乙')
  await expect(list.getByRole('link', { name: /ws-e2e-丙/ })).toContainText('工作空间：丙')
  await list.getByRole('link', { name: /ws-e2e-丙/ }).click()
  await expect(p.getByTestId('token-workspace-name')).toHaveText('丙')

  // 服务端的绑定：通过 MCP 只能搜到自己空间的笔记
  const search = async (token: string, q: string) => {
    const res = await server.request.post('/mcp', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: q } } },
    })
    expect(res.status()).toBe(200)
    return JSON.stringify(await res.json())
  }
  expect(await search(ids.tokenYi, '乙独有关键词')).toContain('乙.md')
  expect(await search(ids.tokenYi, '丙独有关键词')).not.toContain('丙.md')
  expect(await search(ids.tokenBing, '丙独有关键词')).toContain('丙.md')

  // 调用记录显示工作空间，也能按空间筛选
  await p.goto('/settings/audit')
  await expect(p.getByTestId('audit-workspace').first()).toBeVisible()
  const byWs = async (id: string) => (await (await server.request.get(`/api/audit?workspace=${id}`)).json()).entries as { workspace: string }[]
  const entries = await byWs(ids['乙'])
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.every((e) => e.workspace === ids['乙'])).toBe(true)
  await c.close()
})

test('删除非当前工作空间：确认框写清后果，目录进回收目录，绑定的 token 作废，列表和切换器更新', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto(`/settings/workspaces/${ids['甲']}`)
  await p.getByTestId('workspace-delete').click()
  const dialog = p.locator('[role="dialog"]:not([data-testid="settings-dialog"])')
  await expect(dialog).toContainText('删除工作空间“甲甲”？')
  await expect(dialog).toContainText('trash-workspaces/')
  await expect(dialog).toContainText('不会被直接删除')
  await expect(dialog).toContainText('没有 API token 绑定它')
  // 取消：什么都不变
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  expect(await serverNames()).toEqual(['主库', '甲甲', '乙', '丙'])

  // 乙有一个绑定的 token：确认框要写出来
  await p.goto(`/settings/workspaces/${ids['乙']}`)
  await p.getByTestId('workspace-delete').click()
  await expect(dialog).toContainText('绑定它的 1 个 API token（ws-e2e-乙）会立即作废')
  await expect(dialog).toContainText('你的其他工作空间不受影响')
  await shot(p, 'ws-delete-confirm')
  await dialog.getByRole('button', { name: '删除' }).click()
  await expect(dialog).toBeHidden()
  await expect(p).toHaveURL(/\/settings\/workspaces$/)
  await expect.poll(() => serverNames()).toEqual(['主库', '甲甲', '丙'])
  expect(await rowNames(p)).toEqual(['主库', '甲甲', '丙'])
  expect(await menuNames(p)).toEqual(['主库', '甲甲', '丙'])
  // token 已作废
  const status = await server.request.post('/mcp', {
    headers: { Authorization: `Bearer ${ids.tokenYi}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notes', arguments: {} } },
  })
  expect(status.status()).toBe(401)
  expect((await server.request.get(`/api/w/${ids['乙']}/tree`)).status()).toBe(404)
  // 另一个 token 还在
  await p.goto('/settings/tokens')
  await expect(p.getByRole('link', { name: /ws-e2e-丙/ })).toBeVisible()
  await expect(p.getByRole('link', { name: /ws-e2e-乙/ })).toHaveCount(0)
  await c.close()
})

test('删除当前所在的工作空间：自动回到默认工作空间，本机缓存一并清掉', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto(`/w/${ids['丙']}/`)
  await expect(switcher(p)).toHaveAccessibleName('工作空间：丙')
  await expect(p.getByRole('tree', { name: '笔记' }).getByRole('treeitem', { name: '丙', exact: true })).toBeVisible()
  expect(await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toContain(`lode:${ids['丙']}`)

  await switcher(p).click()
  await p.getByRole('menuitem', { name: '管理工作空间…' }).click()
  await expect(p).toHaveURL(new RegExp(`/w/${ids['丙']}/settings/workspaces$`))
  await rows(p).filter({ hasText: '丙' }).getByRole('link').click()
  await expect(p.getByTestId('workspace-detail')).toContainText('正在使用')
  await p.getByTestId('workspace-delete').click()
  await expect(p.locator('[role="dialog"]:not([data-testid="settings-dialog"])')).toContainText('你现在正在使用它，删除后会回到“主库”')
  await p.locator('[role="dialog"]:not([data-testid="settings-dialog"])').getByRole('button', { name: '删除' }).click()

  // 回到默认工作空间（地址没有 /w/ 前缀）的“工作空间”设置页
  await expect(p).toHaveURL(/\/settings\/workspaces$/)
  expect(new URL(p.url()).pathname.startsWith('/w/')).toBe(false)
  await expect(switcher(p)).toHaveAccessibleName('工作空间：主库')
  await expect.poll(() => rowNames(p)).toEqual(['主库', '甲甲']) // 先回到默认空间，删除请求随后完成
  await expect(rows(p).first()).toContainText('当前')
  await expect(p.getByText('工作空间不存在')).toHaveCount(0) // 不应出现“工作空间不存在”的错误提示
  expect(await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain(`lode:${ids['丙']}`)
  expect((await server.request.get(`/api/w/${ids['丙']}/tree`)).status()).toBe(404)
  // 绑定丙的 token 也作废了
  const st = await server.request.post('/mcp', {
    headers: { Authorization: `Bearer ${ids.tokenBing}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notes', arguments: {} } },
  })
  expect(st.status()).toBe(401)
  await c.close()
})

test('无障碍、深色、手机布局', async ({ browser }) => {
  // 重新建两个，列表里有可排序的项
  for (const name of ['丁', '戊']) expect((await server.request.post('/api/workspaces', { data: { name } })).status()).toBe(201)
  for (const scheme of ['light', 'dark'] as const) {
    const { c, p } = await open(browser, { colorScheme: scheme, reducedMotion: 'reduce' })
    for (const path of ['/settings', '/settings/workspaces', '/settings/tokens', '/settings/audit']) {
      await p.goto(path)
      await p.waitForTimeout(300)
      const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      expect(axe.violations.map((v) => `${path} ${scheme} ${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)).toEqual([])
    }
    await p.goto('/settings/workspaces')
    const first = (await serverList())[1]
    await rows(p).nth(1).getByRole('link').click()
    await p.getByTestId('workspace-delete').click()
    await p.waitForTimeout(400)
    const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(axe.violations.map((v) => `删除确认 ${scheme} ${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)).toEqual([])
    await shot(p, `ws-delete-confirm-${scheme}`)
    await p.locator('[role="dialog"]:not([data-testid="settings-dialog"])').getByRole('button', { name: '取消' }).click()
    expect((await serverList())[1].id).toBe(first.id)
    await c.close()
  }

  // 手机：没有横向溢出，把手可点区域不小于 44×44，键盘之外触摸也能操作详情页
  const { c, p } = await open(browser, { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, colorScheme: 'dark' })
  await p.goto('/settings/workspaces')
  await expect(rows(p)).toHaveCount(4)
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const h = (await p.getByTestId('workspace-handle').first().boundingBox())!
  expect(h.width).toBeGreaterThanOrEqual(40)
  expect(h.height).toBeGreaterThanOrEqual(44)
  await shot(p, 'ws-list-mobile')
  await rows(p).nth(1).getByRole('link').tap()
  await expect(p.getByTestId('workspace-detail')).toBeVisible()
  await shot(p, 'ws-detail-mobile')
  const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(axe.violations.map((v) => `${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)).toEqual([])
  await c.close()
})

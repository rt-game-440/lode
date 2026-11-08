import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// #21：助手弹窗“展开”到助手页并接续同一个会话；助手页（弹窗展开、侧栏入口）返回时回到进入前的页面。
// 桌面用浏览器后退，手机用页内返回按钮、左缘返回手势和浏览器后退；直接打开或刷新助手页没有来源，返回回到列表。
// 用 node:http 起模拟的 OpenAI 兼容服务；文件名排在 smoke、talk-to-agent 之后（需要已完成首次设置），结束时删掉自己建的供应商。
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-e2e-1234'
const PROVIDER_NAME = '展开测试供应商'

let mock: Server
let mockBase = ''
let providerId = ''
let originalSettings: unknown = null
let noteId = ''
let otherId = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

/** 回复；用户消息里带“慢速”时分成很多块慢慢输出，用来在生成中途展开 */
async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'expand-model' }] }))
    return
  }
  const body = JSON.parse(await readBody(req)) as { messages: { role: string; content?: unknown }[] }
  const last = body.messages[body.messages.length - 1]
  const slow = JSON.stringify(last.content).includes('慢速')
  const text = slow ? '一二三四五六七八九十，'.repeat(8) + '慢速回复结束。' : `收到：${JSON.stringify(last.content).slice(1, 20)}`
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
  for (const piece of text.match(/.{1,3}/gsu) ?? []) {
    send({ choices: [{ index: 0, delta: { content: piece } }] })
    await sleep(slow ? 120 : 5)
  }
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  res.end('data: [DONE]\n\n')
}

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

test.beforeAll(async ({ browser }) => {
  mock = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`

  const c = await browser.newContext()
  await signIn(c)
  const config = await (await c.request.get('/api/agent/config')).json()
  originalSettings = config.settings
  const res = await c.request.post('/api/agent/providers', { data: { name: PROVIDER_NAME, kind: 'openai', base_url: mockBase, api_key: MOCK_KEY } })
  expect(res.ok()).toBe(true)
  providerId = (await res.json()).id
  const model = { enabled: true, context_window: 128000, max_output: 8192, reasoning: false, effort: 'off', modalities: ['text'], tools: true, temperature: null }
  const m = await c.request.post(`/api/agent/providers/${providerId}/models`, { data: { ...model, model: 'expand-model', name: 'expand-model' } })
  expect(m.ok()).toBe(true)
  await c.request.put('/api/agent/settings', { data: { ...(await (await c.request.get('/api/agent/config')).json()).settings, default_model: (await m.json()).id } })

  const lines = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：用来测试滚动位置保留。`).join('\n\n')
  for (const [path, content] of [
    ['展开/来源笔记.md', `# 来源笔记\n\n${lines}\n`],
    ['展开/另一篇.md', '# 另一篇\n\n内容。\n'],
  ] as const) {
    const tree = await (await c.request.get('/api/tree')).json()
    const existing = tree.notes.find((n: { path: string }) => n.path === path)
    let id: string = existing?.id
    if (!id) {
      const created = await c.request.post('/api/notes', { data: { path, content } })
      expect(created.ok()).toBe(true)
      id = (await created.json()).id
    }
    if (path.includes('来源')) noteId = id
    else otherId = id
  }
  await c.close()
})

test.afterAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  await c.request.delete(`/api/agent/providers/${providerId}`)
  if (originalSettings) await c.request.put('/api/agent/settings', { data: originalSettings })
  await c.close()
  await new Promise((r) => mock.close(r))
})

const assistantButton = (p: Page) => p.locator('.editor-bar').getByRole('button', { name: '助手', exact: true })
const activeChat = (p: Page) => p.evaluate(() => localStorage.getItem('lode.agent.chat'))
const scrollTop = (p: Page) => p.locator('.editor-scroll').evaluate((el) => Math.round(el.scrollTop))

async function openNoteScrolled(p: Page) {
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('第 1 行')
  await p.locator('.editor-scroll').evaluate((el) => (el.scrollTop = 700))
  await p.waitForTimeout(200)
  const top = await scrollTop(p)
  expect(top).toBeGreaterThan(400)
  return top
}

/** 在弹窗里发一条消息，等回复完成 */
async function chatInPopup(p: Page, text: string) {
  const popup = p.getByTestId('agent-popup')
  await popup.getByTestId('agent-input').fill(text)
  await popup.getByTestId('agent-send').click()
  await expect(popup.getByTestId('msg-assistant').last()).toContainText('收到')
}

/* ---------------- 桌面端 ---------------- */

test.describe('桌面端', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })

  test('弹窗对话 → 展开：同一个会话、没发送的草稿带过去、可以继续发送；浏览器后退回到原笔记并保留滚动位置', async ({ page }) => {
    await signIn(page.context())
    const top = await openNoteScrolled(page)
    await assistantButton(page).click()
    await chatInPopup(page, '展开前的一句话')
    const chatId = await activeChat(page)
    expect(chatId).toBeTruthy()
    // 没发送的草稿：展开后还在
    await page.getByTestId('agent-popup').getByTestId('agent-input').fill('还没发送的草稿')
    await page.getByTestId('agent-popup').getByRole('button', { name: '展开到助手页' }).click()

    await expect(page).toHaveURL(/\/agent$/)
    const panel = page.getByTestId('agent-panel')
    await expect(panel.getByTestId('msg-user')).toHaveCount(1)
    await expect(panel.getByTestId('msg-user')).toContainText('展开前的一句话')
    expect(await activeChat(page), '没有新开会话').toBe(chatId)
    await expect(panel.getByTestId('agent-input')).toHaveValue('还没发送的草稿')
    // 继续发送：仍是同一个会话
    await panel.getByTestId('agent-send').click()
    await expect(panel.getByTestId('msg-user')).toHaveCount(2)
    await expect(panel.getByTestId('msg-assistant').last()).toContainText('收到')
    expect(await activeChat(page)).toBe(chatId)

    // 浏览器后退：回到那篇笔记，滚动位置保留
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect(page.locator('.cm-content')).toContainText('用来测试滚动位置保留')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 60)
    expect(await scrollTop(page)).toBeLessThan(top + 60)
    // 再打开弹窗，仍是这个会话，草稿已随发送清空
    await assistantButton(page).click()
    await expect(page.getByTestId('agent-popup').getByTestId('msg-user')).toHaveCount(2)
    await expect(page.getByTestId('agent-popup').getByTestId('agent-input')).toHaveValue('')
  })

  test('生成过程中展开：流不中断，回复完整出现在助手页', async ({ page }) => {
    await signIn(page.context())
    await page.goto(`/note/${noteId}`)
    await assistantButton(page).click()
    const popup = page.getByTestId('agent-popup')
    await popup.getByTestId('agent-input').fill('慢速回复请')
    await popup.getByTestId('agent-send').click()
    await expect(popup.getByTestId('msg-draft')).toBeVisible()
    await popup.getByRole('button', { name: '展开到助手页' }).click()
    await expect(page).toHaveURL(/\/agent$/)
    await expect(page.getByTestId('agent-panel').getByTestId('msg-assistant').last()).toContainText('慢速回复结束', { timeout: 15_000 })
    await expect(page.getByTestId('agent-panel').getByTestId('msg-user')).toHaveCount(1)
  })

  test('侧栏底部入口 → 助手页 → 后退，回到进入前的页面（笔记、废纸篓）', async ({ page }) => {
    await signIn(page.context())
    const top = await openNoteScrolled(page)
    await page.getByTestId('open-agent').click()
    await expect(page).toHaveURL(/\/agent$/)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 60)

    await page.goto('/trash')
    await page.getByTestId('open-agent').click()
    await expect(page).toHaveURL(/\/agent$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/trash$/)
  })
})

/* ---------------- 手机 ---------------- */

test.describe('手机', () => {
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })

  async function edgeSwipeBack(p: Page) {
    const cdp: CDPSession = await p.context().newCDPSession(p)
    const pt = (x: number) => [{ x, y: 420, id: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(4) })
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(4 + i * 30) })
      await sleep(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  async function expandFromSheet(p: Page) {
    await assistantButton(p).click()
    const sheet = p.getByTestId('agent-panel')
    await expect(sheet).toBeVisible()
    await sheet.getByTestId('agent-input').fill('手机上的一句话')
    await sheet.getByTestId('agent-send').click()
    await expect(sheet.getByTestId('msg-assistant').last()).toContainText('收到')
    const chatId = await activeChat(p)
    await sheet.getByRole('button', { name: '展开到助手页' }).click()
    await expect(p).toHaveURL(/\/agent$/)
    await expect(p.getByTestId('agent-panel').getByTestId('msg-user')).toHaveCount(1)
    expect(await activeChat(p), '没有新开会话').toBe(chatId)
  }

  test('底部面板展开 → 返回按钮回到原笔记（滚动位置保留）', async ({ page }) => {
    await signIn(page.context())
    const top = await openNoteScrolled(page)
    await expandFromSheet(page)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect(page.locator('.cm-content')).toContainText('用来测试滚动位置保留')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 60)
  })

  test('左缘返回手势：回到原笔记，而不是列表', async ({ page }) => {
    await signIn(page.context())
    const top = await openNoteScrolled(page)
    await expandFromSheet(page)
    await edgeSwipeBack(page)
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect(page.locator('.cm-content')).toContainText('用来测试滚动位置保留')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 60)
    // 笔记页完整显示在原位，没有停在半路
    await expect(page.locator('.mobile-layer.is-detail')).toBeVisible()
    await expect.poll(() => page.locator('.mobile-layer.is-detail').evaluate((el) => Math.round(el.getBoundingClientRect().x))).toBe(0)
  })

  test('浏览器后退 / 系统返回键：结果一致', async ({ page }) => {
    await signIn(page.context())
    await openNoteScrolled(page)
    await expandFromSheet(page)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect(page.locator('.cm-content')).toContainText('用来测试滚动位置保留')
  })

  test('侧栏入口：从列表进入 → 返回回到列表；从另一篇笔记进入 → 返回回到那篇笔记', async ({ page }) => {
    await signIn(page.context())
    await page.goto('/')
    await page.getByTestId('open-agent').click()
    await expect(page).toHaveURL(/\/agent$/)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('open-agent')).toBeVisible()

    await page.goto(`/note/${otherId}`)
    await expect(page.locator('.cm-content')).toContainText('内容')
    await assistantButton(page).click()
    await page.getByTestId('agent-panel').getByRole('button', { name: '展开到助手页' }).click()
    await edgeSwipeBack(page)
    await expect(page).toHaveURL(new RegExp(`/note/${otherId}$`))
  })

  test('直接打开或刷新助手页：没有来源，返回回到列表', async ({ page }) => {
    await signIn(page.context())
    await page.goto('/agent')
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)

    // 从笔记展开后刷新：刷新后的助手页不再有来源
    await page.goto(`/note/${noteId}`)
    await expect(page.locator('.cm-content')).toContainText('第 1 行')
    await assistantButton(page).click()
    await page.getByTestId('agent-panel').getByRole('button', { name: '展开到助手页' }).click()
    await expect(page).toHaveURL(/\/agent$/)
    await page.reload()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
  })
})

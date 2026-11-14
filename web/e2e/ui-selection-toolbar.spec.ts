import { mkdirSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #73：选中文字后在选区附近浮出工具框（格式、问助手、复制）。
// 覆盖出现与消失（松手后出现、拖选中不出现、Esc、点框外、清空选区、开始输入）、加粗、上方 / 下方两种位置、
// 问助手 → 解释（引用带进弹窗输入框，发出去的消息以 > 引用开头；复用 talk-to-agent 的模拟 OpenAI 兼容服务写法）、
// 复制与复制为链接（读剪贴板）、仅浏览模式只剩问助手和复制、设置开关、没有模型时置灰、键盘 Alt+F10 进入、
// 手机 375 宽度放在选区下方且在视口内、按钮 44×44、axe。
// 文件名排在 smoke 之后（需要已完成首次设置）、visual 之前；自己建的供应商和改动的设置在结束时还原。
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-selection-73'
const PROVIDER_NAME = '选区工具测试供应商'

const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

/* ---------- 模拟的 OpenAI 兼容服务：记下收到的消息，流式回一句话 ---------- */

let mock: Server
let mockBase = ''
const received: { role: string; content?: unknown }[][] = []

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-sel' }] }))
    return
  }
  const body = JSON.parse(await readBody(req)) as { messages: { role: string; content?: unknown }[] }
  received.push(body.messages)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
  send({ choices: [{ index: 0, delta: { content: '这句话说的是选区工具。' } }] })
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })
  res.end('data: [DONE]\n\n')
}

/* ---------- 准备 ---------- */

let providerId = ''
let originalSettings: { default_model?: string } | null = null
let noteId = ''
let topNoteId = ''

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

async function makeNote(c: BrowserContext, path: string, content: string): Promise<string> {
  const tree = await (await c.request.get('/api/tree')).json()
  const existing = tree.notes.find((n: { path: string }) => n.path === path)
  if (existing) await c.request.delete(`/api/notes/${existing.id}`)
  const r = await c.request.post('/api/notes', { data: { path, content } })
  expect(r.ok()).toBe(true)
  return (await r.json()).id as string
}

const FILLER = Array.from({ length: 12 }, (_, i) => `填充段落 ${i + 1}，让目标段落离开编辑区顶部。`).join('\n\n')
/** 每个用例重新建一遍这篇笔记（前面的用例会改它） */
const NOTE_PATH = 'a-sel/选区工具.md'
const BODY = `# 选区工具\n\n${FILLER}\n\n这里有一段目标文字可以选中。\n\n另一段落用来点击清空选区。\n\n${FILLER}\n`

test.describe.configure({ mode: 'serial' })

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
  for (const p of config.providers ?? []) if (p.name === PROVIDER_NAME) await c.request.delete(`/api/agent/providers/${p.id}`)
  const res = await c.request.post('/api/agent/providers', { data: { name: PROVIDER_NAME, kind: 'openai', base_url: mockBase, api_key: MOCK_KEY } })
  expect(res.ok()).toBe(true)
  providerId = (await res.json()).id
  const model = { enabled: true, context_window: 32000, max_output: 4096, reasoning: false, effort: 'off', modalities: ['text'], tools: true, temperature: null }
  const m = await c.request.post(`/api/agent/providers/${providerId}/models`, { data: { ...model, model: 'mock-sel', name: 'mock-sel' } })
  expect(m.ok()).toBe(true)
  const modelId = (await m.json()).id
  // 前面的 spec 可能留下了别的默认模型：这里指定用模拟服务的模型
  expect((await c.request.put('/api/agent/settings', { data: { ...config.settings, default_model: modelId } })).ok()).toBe(true)
  noteId = await makeNote(c, NOTE_PATH, BODY)
  topNoteId = await makeNote(c, 'a-sel/顶部选区.md', '顶部第一行文字用来测试翻到下方。\n\n第二行。\n')
  await c.close()
})

test.afterAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  if (providerId) await c.request.delete(`/api/agent/providers/${providerId}`)
  if (originalSettings) await c.request.put('/api/agent/settings', { data: originalSettings })
  await c.close()
  await new Promise((r) => mock.close(r))
})

async function newPage(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', ...opts })
  await signIn(c)
  const p = await c.newPage()
  return { c, p }
}

/** 正文里某段文字的位置（视口坐标），用来模拟鼠标拖选 */
async function textRect(p: Page, text: string) {
  const r = await p.evaluate((t) => {
    const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(t)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + t.length)
      const b = range.getBoundingClientRect()
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
    }
    return null
  }, text)
  expect(r, `正文里找不到“${text}”`).not.toBeNull()
  return r!
}

/** 鼠标从文字开头拖到结尾；返回松手前（拖动中）工具框是否可见 */
async function dragSelect(p: Page, text: string): Promise<boolean> {
  await p.locator('.cm-line', { hasText: text }).first().scrollIntoViewIfNeeded()
  const r = await textRect(p, text)
  const y = (r.top + r.bottom) / 2
  await p.mouse.move(r.left + 1, y)
  await p.mouse.down()
  await p.mouse.move((r.left + r.right) / 2, y, { steps: 4 })
  await p.mouse.move(r.right - 1, y, { steps: 4 })
  await p.waitForTimeout(450)
  const during = await p.getByTestId('selection-toolbar').isVisible()
  await p.mouse.up()
  return during
}

const toolbar = (p: Page) => p.getByTestId('selection-toolbar')
const noteContent = async (p: Page, id: string) => (await (await p.request.get(`/api/notes/${id}`)).json()).content as string

test('选中后出现：拖选中不出现、松手后出现；加粗包裹 **；Esc、点框外、清空选区、开始输入后消失', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  noteId = await makeNote(c, NOTE_PATH, BODY)
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await p.locator('.cm-line', { hasText: '目标文字' }).scrollIntoViewIfNeeded()

  // 拖动选择过程中不出现，松手后出现在选区上方
  expect(await dragSelect(p, '目标文字')).toBe(false)
  await expect(toolbar(p)).toBeVisible()
  await expect(toolbar(p)).toHaveAttribute('role', 'toolbar')
  await expect(toolbar(p)).toHaveAttribute('data-placement', 'above')
  const sel = await textRect(p, '目标文字')
  const box = (await toolbar(p).boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(sel.top + 1)
  // 提示文字带快捷键
  await expect(toolbar(p).getByTestId('selection-bold')).toHaveAttribute('title', /加粗（(Ctrl\+|⌘)B）/)
  await shot(p, 'desktop-above')

  // 加粗：选区被 ** 包裹，工具框留着（还能接着点斜体等）
  await toolbar(p).getByTestId('selection-bold').click()
  await expect.poll(() => noteContent(p, noteId)).toContain('这里有一段**目标文字**可以选中。')
  await expect(toolbar(p)).toBeVisible()

  // Esc 消失
  await p.keyboard.press('Escape')
  await expect(toolbar(p)).toHaveCount(0)

  // 点框外（侧栏）消失
  await dragSelect(p, '另一段落')
  await expect(toolbar(p)).toBeVisible()
  // 顶栏中间的空白处
  const bar = (await p.locator('.editor-bar').boundingBox())!
  await p.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await expect(toolbar(p)).toHaveCount(0)

  // 清空选区（点正文别处）消失
  await dragSelect(p, '另一段落')
  await expect(toolbar(p)).toBeVisible()
  const other = await textRect(p, '用来点击清空')
  await p.mouse.click(other.right - 2, (other.top + other.bottom) / 2)
  await expect(toolbar(p)).toHaveCount(0)

  // 开始输入（替换选区）消失
  await dragSelect(p, '另一段落')
  await expect(toolbar(p)).toBeVisible()
  await p.keyboard.type('新')
  await expect(toolbar(p)).toHaveCount(0)
  await expect.poll(() => noteContent(p, noteId)).toContain('新用来点击清空选区。')
  await c.close()
})

test('键盘：Shift+方向键选出选区松键后出现；Alt+F10 进入工具框，方向键移动，Esc 回到正文', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  noteId = await makeNote(c, NOTE_PATH, BODY)
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  const r = await textRect(p, '可以选中')
  await p.mouse.click(r.left + 1, (r.top + r.bottom) / 2)
  await expect(toolbar(p)).toHaveCount(0)
  await p.keyboard.down('Shift')
  for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowRight')
  // 还按着 Shift：不出现
  await p.waitForTimeout(500)
  await expect(toolbar(p)).toHaveCount(0)
  await p.keyboard.up('Shift')
  await expect(toolbar(p)).toBeVisible()

  await p.keyboard.press('Alt+F10')
  await expect(toolbar(p).getByTestId('selection-ask')).toBeFocused()
  await p.keyboard.press('ArrowRight')
  await expect(toolbar(p).getByTestId('selection-bold')).toBeFocused()
  await p.keyboard.press('ArrowLeft')
  await p.keyboard.press('ArrowLeft')
  await expect(toolbar(p).getByTestId('selection-copy-link')).toBeFocused()
  await p.keyboard.press('Escape')
  await expect(toolbar(p)).toHaveCount(0)
  await expect(p.locator('.cm-content')).toBeFocused()
  // 选区还在：回到正文后选中的仍是那几个字
  expect(await p.evaluate(() => getSelection()?.toString())).toBe('可以选中')
  await c.close()
})

test('选区靠近编辑区顶部时翻到下方', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  await p.goto(`/note/${topNoteId}`)
  await expect(p.locator('.cm-content')).toContainText('顶部第一行')
  await dragSelect(p, '顶部第一行文字')
  await expect(toolbar(p)).toBeVisible()
  await expect(toolbar(p)).toHaveAttribute('data-placement', 'below')
  const sel = await textRect(p, '顶部第一行文字')
  const box = (await toolbar(p).boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(sel.bottom - 1)
  // 水平方向在编辑区以内
  const area = (await p.locator('.editor-scroll').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(area.x)
  expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width)
  await shot(p, 'desktop-below')
  await c.close()
})

test('问助手 → 解释：打开助手弹窗，输入区带着选中文字的引用，发出的消息以引用开头', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  noteId = await makeNote(c, NOTE_PATH, BODY)
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await dragSelect(p, '可以选中')
  await expect(toolbar(p)).toBeVisible()
  await toolbar(p).getByTestId('selection-ask').click()
  await expect(p.getByRole('menuitem', { name: '解释' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: '改写' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: '翻译' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: '总结' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: '直接提问…' })).toBeVisible()
  await shot(p, 'desktop-ask-menu')
  await p.getByRole('menuitem', { name: '解释' }).click()

  const popup = p.getByTestId('agent-popup')
  await expect(popup).toBeVisible()
  await expect(toolbar(p)).toHaveCount(0)
  await expect(popup.getByTestId('agent-quote')).toContainText('可以选中')
  await expect(popup.getByTestId('agent-input')).toHaveValue('解释一下引用的这段文字。')
  await expect(popup.getByTestId('agent-input')).toBeFocused()
  // 当前笔记仍作为上下文附上
  await expect(popup.locator('.mention-chip.is-context')).toContainText('选区工具')
  await shot(p, 'desktop-ask-popup')

  await popup.getByTestId('agent-send').click()
  await expect(popup.getByTestId('msg-assistant').last()).toContainText('这句话说的是选区工具')
  await expect(popup.getByTestId('msg-user').locator('.msg-quote')).toHaveText('可以选中')
  await expect(popup.getByTestId('agent-quote')).toHaveCount(0)
  const lastUser = received.at(-1)!.filter((m) => m.role === 'user').at(-1)!
  expect(JSON.stringify(lastUser.content)).toContain('> 可以选中\\n\\n解释一下引用的这段文字。')
  await c.close()
})

test('复制、复制为链接：剪贴板内容正确', async ({ browser }) => {
  const { c, p } = await newPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
  noteId = await makeNote(c, NOTE_PATH, BODY)
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await dragSelect(p, '可以选中')
  await toolbar(p).getByTestId('selection-copy').click()
  await expect(toolbar(p)).toHaveCount(0)
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe('可以选中')

  await dragSelect(p, '可以选中')
  await toolbar(p).getByTestId('selection-copy-link').click()
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe('[[选区工具]]')
  await expect(p.locator('.toast').last()).toContainText('[[选区工具]]')
  await c.close()
})

test('仅浏览模式只显示问助手和复制；没有可用模型时问助手置灰并提示去设置', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  // 模拟没有任何模型（不改服务端数据）
  await p.route('**/api/agent/config', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: { ...json, providers: [] } })
  })
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await p.getByTestId('browse-toggle').click()
  await expect(p.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  await dragSelect(p, '可以选中')
  await expect(toolbar(p)).toBeVisible()
  await expect(toolbar(p).getByTestId('selection-bold')).toHaveCount(0)
  await expect(toolbar(p).getByTestId('selection-italic')).toHaveCount(0)
  await expect(toolbar(p).getByTestId('selection-ask')).toBeVisible()
  await expect(toolbar(p).getByTestId('selection-copy')).toBeVisible()
  await expect(toolbar(p).getByTestId('selection-copy-link')).toBeVisible()
  // 没有模型：置灰（aria-disabled），点了提示去设置，不打开弹窗
  const ask = toolbar(p).getByTestId('selection-ask')
  await expect(ask).toHaveAttribute('aria-disabled', 'true')
  await shot(p, 'desktop-browse-no-model')
  // Playwright 把 aria-disabled 当成不可操作；用户仍可以点（置灰但可聚焦）
  await ask.click({ force: true })
  await expect(p.locator('.toast').last()).toContainText('还没有可用的模型')
  await expect(p.locator('.toast').last().getByRole('button', { name: '打开设置' })).toBeVisible()
  await expect(p.getByTestId('agent-popup')).toHaveCount(0)
  await c.close()
})

test('设置 → 编辑器里关掉“选中文字时显示悬浮工具”后不再出现，格式顶栏不受影响', async ({ browser }) => {
  const { c, p } = await newPage(browser)
  await p.goto('/settings/editor')
  const sw = p.getByTestId('selection-toolbar-switch')
  await expect(sw).toBeChecked()
  await sw.click()
  await expect(sw).not.toBeChecked()
  await expect(p.getByTestId('format-toolbar-switch')).toBeChecked()

  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await expect(p.getByTestId('format-toolbar')).toBeVisible()
  await dragSelect(p, '可以选中')
  await p.waitForTimeout(500)
  await expect(toolbar(p)).toHaveCount(0)

  await p.goto('/settings/editor')
  await p.getByTestId('selection-toolbar-switch').click()
  await expect(p.getByTestId('selection-toolbar-switch')).toBeChecked()
  await c.close()
})

test('减弱动态效果：出现时只淡入，不缩放、不位移', async ({ browser }) => {
  const { c, p } = await newPage(browser, { reducedMotion: 'reduce' })
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  // 出现后的头几帧：transform 始终为 none，透明度从小到 1
  await p.evaluate(() => {
    const w = window as unknown as { __samples: { t: string; o: number }[] }
    w.__samples = []
    const tick = () => {
      const el = document.querySelector<HTMLElement>('[data-testid="selection-toolbar"]')
      if (el) {
        const cs = getComputedStyle(el)
        w.__samples.push({ t: cs.transform, o: Number(cs.opacity) })
      }
      if (w.__samples.length < 12) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await dragSelect(p, '可以选中')
  await expect(toolbar(p)).toBeVisible()
  await expect.poll(() => p.evaluate(() => (window as unknown as { __samples: unknown[] }).__samples.length)).toBeGreaterThanOrEqual(12)
  const samples = await p.evaluate(() => (window as unknown as { __samples: { t: string; o: number }[] }).__samples)
  expect(samples.every((s) => s.t === 'none')).toBe(true)
  expect(samples[0].o).toBeLessThan(1)
  await c.close()
})

test('深色模式截图', async ({ browser }) => {
  test.skip(!shotDir, '只在截图时运行')
  const { c, p } = await newPage(browser, { colorScheme: 'dark' })
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await dragSelect(p, '可以选中')
  await expect(toolbar(p)).toBeVisible()
  await shot(p, 'desktop-dark')
  await c.close()
})

test('手机 375：触摸选区停下后出现在选区下方、在视口内且不被键盘工具栏盖住；按钮 44×44；axe 通过', async ({ browser }) => {
  const { c, p } = await newPage(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('目标文字')
  await p.locator('.cm-line', { hasText: '目标文字' }).scrollIntoViewIfNeeded()
  // 触摸长按选字由系统完成：这里直接设 DOM 选区（与系统拖柄调整后 CodeMirror 收到的一样），没有鼠标按下
  await p.locator('.cm-line', { hasText: '目标文字' }).tap()
  await expect(p.getByTestId('mobile-toolbar')).toBeVisible()
  await p.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf('可以选中')
      if (i < 0) continue
      getSelection()!.setBaseAndExtent(n, i, n, i + 4)
      return
    }
  })
  await expect(toolbar(p)).toBeVisible()
  await expect(toolbar(p)).toHaveAttribute('data-placement', 'below')
  const sel = await textRect(p, '可以选中')
  const box = (await toolbar(p).boundingBox())!
  // 在选区下方，并让出拖柄
  expect(box.y).toBeGreaterThanOrEqual(sel.bottom + 20)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  const mt = (await p.getByTestId('mobile-toolbar').boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(mt.y)
  // 按钮触摸区域不小于 44×44
  for (const b of await toolbar(p).locator('button').all()) {
    const bb = (await b.boundingBox())!
    expect(bb.width).toBeGreaterThanOrEqual(44)
    expect(bb.height).toBeGreaterThanOrEqual(44)
  }
  // 引用、笔记链接、复制为链接收进“更多”
  await expect(toolbar(p).getByTestId('selection-copy-link')).toHaveCount(0)
  await shot(p, 'mobile-below')
  const axe = await new AxeBuilder({ page: p }).include('[data-testid="selection-toolbar"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)
  expect(bad).toEqual([])
  await toolbar(p).getByTestId('selection-more').tap()
  await expect(p.getByRole('menuitem', { name: '复制为链接' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: '引用' })).toBeVisible()
  await shot(p, 'mobile-more')
  await c.close()
})

test('桌面 axe：亮色和深色下工具框没有 serious / critical 问题', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const { c, p } = await newPage(browser, { colorScheme })
    await p.goto(`/note/${noteId}`)
    await expect(p.locator('.cm-content')).toContainText('目标文字')
    await dragSelect(p, '可以选中')
    await expect(toolbar(p)).toBeVisible()
    await p.waitForTimeout(400)
    const axe = await new AxeBuilder({ page: p }).include('[data-testid="selection-toolbar"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)
    expect(bad, colorScheme).toEqual([])
    await c.close()
  }
})

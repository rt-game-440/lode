import AxeBuilder from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { type BrowserContext, type Page, expect, test } from '@playwright/test'

// #44：助手输入框重做——单层边框与同心圆角、@ 内联补全、当前笔记不再反复自动附上、自定义模型选择器。
// 自带模拟的 OpenAI 兼容服务（回复里带上收到的模型 ID），建两个供应商，结束时清理，免得影响期待“未配置”的 talk-to-agent。
// 文件名排在 talk-to-agent、smoke 之后（需要已完成首次设置）。
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-e2e-1234'
// 设置 LODE_SCREENSHOTS=<目录名> 时截图（3 级验收），输出到 docs/screenshots/<目录名>/
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

let mock: Server
let mockBase = ''
/** 模拟服务收到的请求里的模型 ID */
const received: string[] = []
let contextId = ''
const created: string[] = []
let originalSettings: unknown = null

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404)
    res.end()
    return
  }
  const body = JSON.parse(await readBody(req)) as { model: string }
  received.push(body.model)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
  send({ choices: [{ index: 0, delta: { content: `这是 ${body.model} 的回复。` } }] })
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })
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

const model = { enabled: true, context_window: 32000, max_output: 4096, reasoning: false, effort: 'off', modalities: ['text'], tools: true, temperature: null }

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
  originalSettings = (await (await c.request.get('/api/agent/config')).json()).settings
  const addProvider = async (name: string) => {
    const res = await c.request.post('/api/agent/providers', { data: { name, kind: 'openai', base_url: mockBase, api_key: MOCK_KEY } })
    expect(res.ok()).toBe(true)
    const p = await res.json()
    created.push(p.id)
    return p.id as string
  }
  const addModel = async (pid: string, data: Record<string, unknown>) => {
    expect((await c.request.post(`/api/agent/providers/${pid}/models`, { data: { ...model, ...data } })).ok()).toBe(true)
  }
  const a = await addProvider('模拟甲')
  await addModel(a, { model: 'alpha-fast', name: 'alpha-fast' })
  await addModel(a, { model: 'alpha-think', name: 'alpha-think', reasoning: true, effort: 'medium', modalities: ['text', 'image'] })
  const b = await addProvider('模拟乙')
  // 没有显示名：按钮上显示简短 ID
  await addModel(b, { model: 'acme/beta-long-model-identifier', name: '' })

  const tree = await (await c.request.get('/api/tree')).json()
  // 默认模型指向 alpha-fast（别的用例可能已经配过默认模型）
  const cfg = await (await c.request.get('/api/agent/config')).json()
  const fast = cfg.providers.flatMap((p: { models: { id: string; model: string }[] }) => p.models).find((m: { model: string }) => m.model === 'alpha-fast')
  expect((await c.request.put('/api/agent/settings', { data: { ...cfg.settings, default_model: fast.id } })).ok()).toBe(true)

  const note = async (path: string, content: string) => {
    const existing = tree.notes.find((n: { path: string }) => n.path === path)
    if (existing) return existing.id as string
    const res = await c.request.post('/api/notes', { data: { path, content } })
    expect(res.ok()).toBe(true)
    return (await res.json()).id as string
  }
  contextId = await note('输入框/当前笔记.md', '# 当前笔记\n\n助手输入框测试用。\n')
  await note('输入框/读三国演义有感.md', '# 读三国演义有感\n\n正文。\n')
  await note('输入框/三国志笔记.md', '# 三国志笔记\n\n正文。\n')
  await note('输入框/购物清单.md', '# 购物清单\n\n- 牛奶\n')
  await c.close()
})

test.afterAll(async ({ browser }) => {
  await new Promise((r) => mock.close(r))
  const c = await browser.newContext()
  await signIn(c)
  for (const id of created) await c.request.delete(`/api/agent/providers/${id}`)
  if (originalSettings) await c.request.put('/api/agent/settings', { data: originalSettings })
  await c.close()
})

const assistantButton = (p: Page) => p.locator('.editor-bar').getByRole('button', { name: '助手', exact: true })

async function openPopup(page: Page, mobile = false) {
  await signIn(page.context())
  await page.goto(`/note/${contextId}`)
  await expect(page.locator('.cm-content')).toContainText('助手输入框测试用')
  await page.waitForTimeout(mobile ? 400 : 0)
  if (mobile) await assistantButton(page).tap()
  else await assistantButton(page).click()
  const popup = page.getByTestId(mobile ? 'bottom-sheet' : 'agent-popup')
  await expect(popup).toBeVisible()
  await expect(popup.getByTestId('agent-input')).toBeVisible()
  await page.waitForTimeout(500)
  return popup
}

/** 发送一条消息并等回复结束 */
async function say(popup: ReturnType<Page['getByTestId']>, text: string) {
  const n = await popup.getByTestId('msg-assistant').count()
  await popup.getByTestId('agent-input').fill(text)
  await popup.getByTestId('agent-send').click()
  await expect(popup.getByTestId('msg-assistant')).toHaveCount(n + 1)
  await expect(popup.getByTestId('agent-send')).toBeVisible()
}

test.describe('桌面端', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })

  test('只有外层一圈边框：聚焦时外层高亮，内部文本框无边框和焦点框；圆角同心', async ({ page }) => {
    const popup = await openPopup(page)
    const input = popup.getByTestId('agent-input')
    await input.focus()
    const style = async () => {
      await page.waitForTimeout(350) // 等边框颜色的过渡结束
      return popup.evaluate(() => {
        const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!)
        const c = cs('.composer')
        const i = cs('.composer-input')
        return {
          composerBorder: c.borderTopColor,
          composerWidth: c.borderTopWidth,
          composerRadius: c.borderTopLeftRadius,
          composerShadow: c.boxShadow,
          inputBorder: i.borderTopWidth,
          inputOutline: i.outlineStyle,
          inputShadow: i.boxShadow,
          chip: cs('.composer .mention-chip').borderTopLeftRadius,
          at: cs('[data-testid="agent-at"]').borderTopLeftRadius,
          model: cs('.composer-model').borderTopLeftRadius,
          send: cs('.composer-send').borderTopLeftRadius,
        }
      })
    }
    const focused = await style()
    expect(focused.composerWidth).toBe('1px')
    expect(focused.inputBorder).toBe('0px')
    expect(focused.inputOutline).toBe('none')
    expect(focused.inputShadow).toBe('none')
    // 外层高亮：边框变色，并多出焦点环（键盘 Tab 聚焦同样可辨识）
    expect(focused.composerShadow).toMatch(/3px/)
    await shot(page, 'composer-focused-light')
    await popup.getByRole('button', { name: '全部对话' }).focus()
    const blurred = await style()
    expect(blurred.composerBorder).not.toBe(focused.composerBorder)
    expect(blurred.composerShadow).not.toMatch(/3px/)
    await input.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(input).toBeFocused()
    expect((await style()).composerShadow).toMatch(/3px/)
    // 圆角：外层 16（--radius-xl），内层统一 8（--radius-md），同心
    expect(focused.composerRadius).toBe('16px')
    for (const k of ['chip', 'at', 'model', 'send'] as const) expect(focused[k], k).toBe('8px')
  })

  test('@ 内联补全：紧贴输入框、无遮罩、实时过滤、方向键 / Enter / Tab / Esc，焦点不离开输入框', async ({ page }) => {
    const popup = await openPopup(page)
    const input = popup.getByTestId('agent-input')
    const menu = popup.getByTestId('mention-menu')
    const options = menu.getByRole('option')
    await input.click()
    await input.pressSequentially('看看 @')
    await expect(menu).toBeVisible()
    await expect(input).toBeFocused()
    // 无遮罩；列表紧贴输入框上方
    await expect(page.locator('.scrim, .sheet-scrim')).toHaveCount(0)
    const mb = (await menu.boundingBox())!
    const cb = (await popup.locator('.composer').boundingBox())!
    expect(cb.y - (mb.y + mb.height)).toBeGreaterThanOrEqual(0)
    expect(cb.y - (mb.y + mb.height)).toBeLessThan(16)
    await shot(page, 'mention-menu-desktop')
    // 当前笔记已自动附上，不在候选里
    await expect(menu).not.toContainText('当前笔记.md')

    // 继续输入的文字实时过滤
    await input.pressSequentially('三国')
    await expect(options).toHaveCount(2)
    await expect(input).toBeFocused()
    await input.pressSequentially('志')
    await expect(options).toHaveCount(1)
    await expect(options.first()).toContainText('三国志笔记')
    await input.press('Backspace')
    await expect(options).toHaveCount(2)

    // 方向键移动高亮，Enter 确认：插入标签、去掉 @ 和查询词，焦点仍在输入框
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowUp')
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowDown')
    const second = (await options.nth(1).locator('.mention-title').textContent())!
    await input.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(popup.locator('.composer-chips .mention-chip', { hasText: second })).toHaveCount(1)
    await expect(input).toHaveValue('看看 ')
    await expect(input).toBeFocused()
    // 没有被当成发送
    await expect(popup.getByTestId('msg-user')).toHaveCount(0)

    // Tab 确认另一篇
    await input.pressSequentially('@三国')
    await expect(options).toHaveCount(1)
    await input.press('Tab')
    await expect(menu).toHaveCount(0)
    await expect(popup.locator('.composer-chips .mention-chip')).toHaveCount(3) // 当前笔记 + 两篇三国
    await expect(input).toBeFocused()

    // Esc 只关补全，不关弹窗；同一个 @ 里继续输入不会重新弹出
    await input.fill('')
    await input.pressSequentially('@购')
    await expect(options).toHaveCount(1)
    await input.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(popup).toBeVisible()
    await expect(input).toBeFocused()
    await input.pressSequentially('物')
    await expect(menu).toHaveCount(0)
    // 删掉 @ 关闭；重新输入 @ 又能打开
    await input.fill('')
    await input.pressSequentially('@')
    await expect(menu).toBeVisible()
    await input.press('Backspace')
    await expect(menu).toHaveCount(0)
    // 点 @ 按钮等同于输入 @，焦点留在输入框
    await input.fill('带上')
    await popup.getByTestId('agent-at').click()
    await expect(input).toHaveValue('带上 @')
    await expect(menu).toBeVisible()
    await expect(input).toBeFocused()
    // 点列表项也能选，焦点不离开
    await menu.getByRole('option', { name: /购物清单/ }).click()
    await expect(popup.locator('.composer-chips .mention-chip', { hasText: '购物清单' })).toHaveCount(1)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('带上 ')
    // 邮箱里的 @ 不触发
    await input.fill('')
    await input.pressSequentially('a@b')
    await expect(menu).toHaveCount(0)
  })

  test('当前笔记：移除后发送，之后每一轮都不再自动附上；点“附上当前笔记”才附；已附过的不重复', async ({ page }) => {
    const popup = await openPopup(page)
    const chip = popup.locator('.composer-chips .mention-chip.is-context')
    const ghost = popup.getByRole('button', { name: '附上当前笔记' })
    await expect(chip).toContainText('当前笔记')
    await expect(ghost).toHaveCount(0)
    // 移除：变成虚线建议标签
    await chip.getByRole('button', { name: /不附上/ }).click()
    await expect(chip).toHaveCount(0)
    await expect(ghost).toBeVisible()
    await expect(ghost).toHaveClass(/is-ghost/)
    await shot(page, 'ghost-chip')

    await say(popup, '第一轮，不附笔记')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveCount(0)
    // 发送之后仍然没有自动附上
    await expect(chip).toHaveCount(0)
    await expect(ghost).toBeVisible()
    await say(popup, '第二轮，还是不附')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveCount(0)
    await expect(chip).toHaveCount(0)

    // 点一下才附上；这一轮的消息带着它
    await ghost.click()
    await expect(chip).toContainText('当前笔记')
    await say(popup, '第三轮，附上')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveText('当前笔记')
    // 已经附过：发送后不会再自动出现实线标签，只剩建议标签
    await expect(chip).toHaveCount(0)
    await expect(ghost).toBeVisible()
    await say(popup, '第四轮，不重复')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveCount(0)

    // 新对话：重新开始，当前笔记再次自动附上；发送后不重复
    await popup.getByRole('button', { name: '新对话' }).click()
    await expect(chip).toContainText('当前笔记')
    await say(popup, '新对话第一轮')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveText('当前笔记')
    await expect(chip).toHaveCount(0)
    await say(popup, '新对话第二轮')
    await expect(popup.getByTestId('msg-user').last().locator('.mention-chip')).toHaveCount(0)
  })

  test('模型选择器：自定义菜单，按供应商分组、当前项打勾、键盘可操作、推理强度在同一菜单；切换后发送用新模型', async ({ page }) => {
    const popup = await openPopup(page)
    await expect(popup.locator('select')).toHaveCount(0)
    const trigger = popup.getByTestId('model-select')
    await expect(trigger).toContainText('alpha-fast')
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // 分组标题、当前项打勾、能力提示
    await expect(menu).toContainText('模拟甲')
    await expect(menu).toContainText('模拟乙')
    const items = menu.getByRole('menuitemradio')
    await expect(items.filter({ hasText: 'alpha-fast' })).toHaveAttribute('aria-checked', 'true')
    await expect(items.filter({ hasText: 'alpha-think' })).toContainText('推理')
    await expect(items.filter({ hasText: 'alpha-think' })).toContainText('图片')
    // 没有显示名的模型用简短 ID
    await expect(items.filter({ hasText: 'beta-long-model-identifier' })).toHaveCount(1)
    await shot(page, 'model-menu-desktop')
    // 键盘：焦点在当前项，方向键移动，Enter 选择
    await expect(items.filter({ hasText: 'alpha-fast' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.filter({ hasText: 'alpha-think' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toContainText('alpha-think')

    // 推理模型：同一个菜单里切换推理强度
    await trigger.click()
    await expect(menu.getByText('推理强度')).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /默认/ })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: '高', exact: true }).click()
    await trigger.click()
    await expect(menu.getByRole('menuitemradio', { name: '高', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(popup).toBeVisible() // Esc 只关菜单

    // 换到另一个供应商的模型（简短 ID），发送用新模型
    await trigger.click()
    await menu.getByRole('menuitemradio', { name: /beta-long-model-identifier/ }).click()
    await expect(trigger).toContainText('beta-long-model-identifier')
    await say(popup, '换个模型')
    expect(received.at(-1)).toBe('acme/beta-long-model-identifier')
    await expect(popup.getByTestId('msg-assistant').last()).toContainText('这是 acme/beta-long-model-identifier 的回复')
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe：${scheme} 下展开 @ 补全和模型菜单没有 serious / critical 问题`, async ({ browser }) => {
      const c = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
      const page = await c.newPage()
      const popup = await openPopup(page)
      const input = popup.getByTestId('agent-input')
      await input.click()
      await input.pressSequentially('@')
      await expect(popup.getByTestId('mention-menu')).toBeVisible()
      await page.waitForTimeout(500)
      await shot(page, `composer-mention-${scheme}`)
      const scan = async () => {
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        return result.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}（${v.impact}）：${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join('；')}`)
      }
      expect(await scan()).toEqual([])
      await input.fill('')
      await popup.getByTestId('model-select').click()
      await expect(page.getByRole('menu')).toBeVisible()
      await page.waitForTimeout(500)
      await shot(page, `composer-model-menu-${scheme}`)
      expect(await scan()).toEqual([])
      await c.close()
    })
  }
})

test.describe('手机端：底部面板', () => {
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })

  test('@ 补全在输入框上方、完整可见；模型菜单贴近按钮；单层边框', async ({ page }) => {
    const sheet = await openPopup(page, true)
    const input = sheet.getByTestId('agent-input')
    await input.tap()
    await page.waitForTimeout(500)
    await sheet.getByTestId('agent-at').tap()
    const menu = sheet.getByTestId('mention-menu')
    await expect(menu).toBeVisible()
    await expect(input).toBeFocused()
    await page.waitForTimeout(400)
    const mb = (await menu.boundingBox())!
    const cb = (await sheet.locator('.composer').boundingBox())!
    expect(mb.y).toBeGreaterThanOrEqual(0)
    expect(mb.y + mb.height).toBeLessThanOrEqual(cb.y + 1)
    expect(mb.x).toBeGreaterThanOrEqual(0)
    expect(mb.x + mb.width).toBeLessThanOrEqual(375)
    await shot(page, 'mention-menu-mobile')
    await menu.getByRole('option').first().tap()
    await expect(menu).toHaveCount(0)
    await expect(sheet.locator('.composer-chips .mention-chip')).toHaveCount(2)
    const inner = await input.evaluate((el) => {
      const s = getComputedStyle(el)
      return { border: s.borderTopWidth, outline: s.outlineStyle }
    })
    expect(inner).toEqual({ border: '0px', outline: 'none' })

    const trigger = sheet.getByTestId('model-select')
    await trigger.tap()
    const mm = page.getByRole('menu')
    await expect(mm).toBeVisible()
    await page.waitForTimeout(400)
    const box = (await mm.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(812)
    await shot(page, 'model-menu-mobile')
  })

  test('外接键盘按 Esc 只关 @ 补全，不关底部面板；再按一次才关面板', async ({ page }) => {
    const sheet = await openPopup(page, true)
    const input = sheet.getByTestId('agent-input')
    await input.tap()
    await page.waitForTimeout(500)
    await input.pressSequentially('@')
    const menu = sheet.getByTestId('mention-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('bottom-sheet')).toHaveCount(0)
  })
})

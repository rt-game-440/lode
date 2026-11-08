import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// #20：笔记页里的助手统一在弹窗里打开。桌面是浮在编辑区上的非模态面板，手机是底部半屏面板（可拖到全屏、下滑关闭）；
// 当前笔记作为上下文，关闭后回到笔记，正在写的内容、光标和滚动位置不丢；右栏不再有“助手”标签；减弱动态效果时只淡入淡出。
// 助手完整流程（流式回复、批准写入、展开接续会话）在 talk-to-agent.spec。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）。
const PASSWORD = 'e2e-test-password'
// 设置 LODE_SCREENSHOTS=<目录名> 时截图（3 级验收），输出到 docs/screenshots/<目录名>/
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

const PROVIDER_NAME = '弹窗测试供应商'
let noteId = ''
/** 本文件建的供应商：结束后删掉，免得影响期待“未配置”的 talk-to-agent */
let providerId = ''
/** 建供应商之前的助手设置（创建第一个模型会把它设为默认模型），结束时还原 */
let originalSettings: unknown = null

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

test.beforeAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  // 没有供应商时建一个（不带 API key，不会真的请求），输入框才会出现
  const config = await (await c.request.get('/api/agent/config')).json()
  if (!config.providers?.length) {
    const res = await c.request.post('/api/agent/providers', { data: { name: PROVIDER_NAME, kind: 'openai', base_url: 'http://127.0.0.1:9/v1' } })
    expect(res.ok()).toBe(true)
    const provider = await res.json()
    providerId = provider.id
    originalSettings = config.settings
    const model = { enabled: true, context_window: 128000, max_output: 8192, reasoning: false, effort: 'off', modalities: ['text'], tools: true, temperature: null }
    expect((await c.request.post(`/api/agent/providers/${provider.id}/models`, { data: { ...model, model: 'popup-model', name: 'popup-model' } })).ok()).toBe(true)
  }
  const lines = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：用来测试滚动位置不丢。`).join('\n\n')
  const path = '弹窗/助手弹窗.md'
  const tree = await (await c.request.get('/api/tree')).json()
  const existing = tree.notes.find((n: { path: string }) => n.path === path)
  if (existing) noteId = existing.id
  else {
    const res = await c.request.post('/api/notes', { data: { path, content: `# 助手弹窗\n\n${lines}\n` } })
    expect(res.ok()).toBe(true)
    noteId = (await res.json()).id
  }
  await c.close()
})

test.afterAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  const config = await (await c.request.get('/api/agent/config')).json()
  for (const p of config.providers ?? []) if (p.name === PROVIDER_NAME || p.id === providerId) await c.request.delete(`/api/agent/providers/${p.id}`)
  if (originalSettings) await c.request.put('/api/agent/settings', { data: originalSettings })
  await c.close()
})

const assistantButton = (p: Page) => p.locator('.editor-bar').getByRole('button', { name: '助手', exact: true })

/** 编辑器的状态：滚动位置、CodeMirror 里保存的光标位置、全文（焦点离开编辑器后 DOM 选区会跟着走，所以读编辑器自己的状态） */
async function editorState(p: Page) {
  return p.evaluate(() => {
    const content = document.querySelector('.cm-content')
    // 光标由 CodeMirror 自己绘制（drawSelection），位置来自编辑器状态；编辑器失去焦点后仍保留
    const cursor = document.querySelector<HTMLElement>('.cm-cursorLayer .cm-cursor')
    return {
      scrollTop: Math.round(document.querySelector('.editor-scroll')!.scrollTop),
      caret: cursor ? `${cursor.style.left},${cursor.style.top}` : '',
      text: content?.textContent ?? '',
    }
  })
}

/** 在长笔记末尾追加一段，再滚到中间：返回此时的编辑器状态 */
async function writeAndScroll(p: Page) {
  await p.locator('.cm-content').click()
  await p.keyboard.press('Control+End')
  await p.keyboard.type('弹窗前写的一句话')
  await p.locator('.editor-scroll').evaluate((el) => (el.scrollTop = 600))
  await p.waitForTimeout(200)
  const s = await editorState(p)
  expect(s.scrollTop).toBeGreaterThan(300)
  expect(s.caret, '读到了 CodeMirror 的光标位置').toMatch(/^[\d.]+px,\s*[\d.]+px$/)
  return s
}

/* ---------------- 桌面端 ---------------- */

test.describe('桌面端：浮在编辑区上的非模态面板', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })

  test('点助手图标打开弹窗，当前笔记作为上下文；右栏只有反链 / 大纲 / 标签', async ({ page }) => {
    await signIn(page.context())
    await page.goto(`/note/${noteId}`)
    await expect(page.locator('.cm-content')).toContainText('第 1 行')

    const tabs = page.locator('.right-tabs').getByRole('tab')
    await expect(tabs).toHaveText(['反链', '大纲', '标签'])

    await assistantButton(page).click()
    const popup = page.getByTestId('agent-popup')
    await expect(popup).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    // 非模态：没有遮罩，编辑区还能继续操作；弹窗浮在编辑区上方、没有挤占右栏
    await expect(popup).toHaveAttribute('aria-modal', 'false')
    await expect(page.locator('.drawer-scrim, .sheet-scrim, .scrim')).toHaveCount(0)
    await expect(assistantButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(popup.locator('.mention-chip.is-context')).toContainText('助手弹窗')
    await expect(popup.getByTestId('agent-input')).toBeFocused()
    const main = (await page.locator('.shell-main').boundingBox())!
    const box = (await popup.boundingBox())!
    expect(box.x).toBeGreaterThan(main.x)
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width)
    await shot(page, 'agent-popup-desktop')
    // 打开助手后右栏标签仍只有三个，右栏的收起按钮不受影响（#19）
    await expect(tabs).toHaveText(['反链', '大纲', '标签'])
    await page.getByRole('button', { name: '隐藏右栏' }).click()
    await expect(page.getByRole('button', { name: '显示右栏' })).toBeVisible()
    await expect(popup).toBeVisible()
    await page.getByRole('button', { name: '显示右栏' }).click()
    await expect(page.getByRole('button', { name: '隐藏右栏' })).toBeVisible()
  })

  test('旧版本保存的“助手”标签偏好不会让右栏空白', async ({ browser }) => {
    const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
    await signIn(c)
    await c.addInitScript(() => localStorage.setItem('lode.layout', JSON.stringify({ sidebarOpen: true, rightOpen: true, rightTab: 'agent' })))
    const p = await c.newPage()
    await p.goto(`/note/${noteId}`)
    await expect(p.locator('.cm-content')).toContainText('第 1 行')
    await expect(p.getByRole('tab', { name: '反链' })).toHaveAttribute('aria-selected', 'true')
    await expect(p.getByRole('tab', { name: '助手' })).toHaveCount(0)
    await c.close()
  })

  test('关闭按钮、Esc、再点助手图标都能关闭；焦点回到助手图标；内容、光标、滚动位置不变', async ({ page }) => {
    await signIn(page.context())
    await page.goto(`/note/${noteId}`)
    await expect(page.locator('.cm-content')).toContainText('第 1 行')
    const before = await writeAndScroll(page)
    const popup = page.getByTestId('agent-popup')

    for (const how of ['关闭按钮', 'Esc', '助手图标'] as const) {
      await assistantButton(page).click()
      await expect(popup).toBeVisible()
      await popup.getByTestId('agent-input').fill(`草稿 ${how}`)
      if (how === '关闭按钮') await popup.getByRole('button', { name: '关闭助手' }).click()
      else if (how === 'Esc') await page.keyboard.press('Escape')
      else await assistantButton(page).click()
      await expect(popup).toHaveCount(0)
      await expect(assistantButton(page)).toBeFocused()
      await expect(assistantButton(page)).toHaveAttribute('aria-pressed', 'false')
      const after = await editorState(page)
      expect(after, `${how}关闭后`).toEqual(before)
    }
    // 内容已经保存，笔记页没有被替换
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect.poll(async () => (await (await page.request.get(`/api/notes/${noteId}`)).json()).content).toContain('弹窗前写的一句话')
  })

  test('展开按钮：关闭弹窗，跳到整页助手', async ({ page }) => {
    await signIn(page.context())
    await page.goto(`/note/${noteId}`)
    await assistantButton(page).click()
    await page.getByTestId('agent-popup').getByRole('button', { name: '展开到助手页' }).click()
    await expect(page).toHaveURL(/\/agent$/)
    await expect(page.getByTestId('agent-popup')).toHaveCount(0)
    await expect(page.getByTestId('agent-panel')).toBeVisible()
  })

  test('侧栏底部的助手入口仍是整页，不是弹窗', async ({ page }) => {
    await signIn(page.context())
    await page.goto(`/note/${noteId}`)
    await page.getByTestId('open-agent').click()
    await expect(page).toHaveURL(/\/agent$/)
    await expect(page.getByTestId('agent-popup')).toHaveCount(0)
  })

  test('弹窗从助手按钮附近弹出（缩放入场）；减弱动态效果时只淡入淡出', async ({ browser }) => {
    for (const reduce of [false, true]) {
      const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, reducedMotion: reduce ? 'reduce' : 'no-preference' })
      await signIn(c)
      const p = await c.newPage()
      await p.goto(`/note/${noteId}`)
      await expect(p.locator('.cm-content')).toContainText('第 1 行')
      await p.evaluate(() => {
        const w = window as unknown as { __frames: { scale: number; op: number; origin: string }[] }
        w.__frames = []
        const tick = () => {
          const el = document.querySelector<HTMLElement>('[data-testid="agent-popup"]')
          if (el) {
            const cs = getComputedStyle(el)
            w.__frames.push({ scale: new DOMMatrix(cs.transform).a, op: parseFloat(cs.opacity), origin: cs.transformOrigin })
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await assistantButton(p).click()
      await expect(p.getByTestId('agent-popup')).toBeVisible()
      await p.waitForTimeout(700)
      const frames = await p.evaluate(() => (window as unknown as { __frames: { scale: number; op: number; origin: string }[] }).__frames)
      expect(frames.length).toBeGreaterThan(3)
      expect(frames.at(-1)!.op).toBeCloseTo(1, 1)
      expect(frames.at(-1)!.scale).toBeCloseTo(1, 2)
      if (reduce) {
        expect(frames.every((f) => Math.abs(f.scale - 1) < 1e-6), '减弱动态效果：没有缩放').toBe(true)
        expect(frames[0].op).toBeLessThan(0.95)
      } else {
        expect(Math.min(...frames.map((f) => f.scale)), '入场有缩放').toBeLessThan(0.99)
      }
      await c.close()
    }
  })
})

/* ---------------- 手机端 ---------------- */

test.describe('手机端：底部半屏面板', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })

  let cdp: CDPSession
  async function openMobile(page: Page) {
    await signIn(page.context())
    cdp = await page.context().newCDPSession(page)
    await page.goto(`/note/${noteId}`)
    await expect(page.locator('.cm-content')).toContainText('第 1 行')
    await page.waitForTimeout(400)
  }
  /** 一次触摸拖动（手指不停留，松手时带着速度） */
  async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8, stepMs = 16) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
      await page.waitForTimeout(stepMs)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const sheetTop = (p: Page) => p.getByTestId('bottom-sheet').evaluate((el) => el.getBoundingClientRect().top)
  const headerCenter = async (p: Page) => {
    const b = (await p.getByTestId('bottom-sheet').locator('.agent-head').boundingBox())!
    return { x: b.x + 24, y: b.y + b.height / 2 }
  }

  test('点助手图标：底部弹出半屏面板，留在笔记页，当前笔记作为上下文', async ({ page }) => {
    await openMobile(page)
    await assistantButton(page).tap()
    const sheet = page.getByTestId('bottom-sheet')
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
    await expect(sheet).toHaveAttribute('data-snap', 'half')
    await expect(sheet.locator('.mention-chip.is-context')).toContainText('助手弹窗')
    await page.waitForTimeout(600)
    // 半屏：面板顶部在屏幕中部附近（露出约 55%），下面有遮罩
    const top = await sheetTop(page)
    expect(top).toBeGreaterThan(812 * 0.35)
    expect(top).toBeLessThan(812 * 0.55)
    await expect(page.getByTestId('sheet-scrim')).toBeVisible()
    await shot(page, 'agent-popup-mobile-half')
  })

  test('点遮罩、Esc、下滑都能关闭；焦点回到助手图标；内容、光标、滚动位置不变', async ({ page }) => {
    await openMobile(page)
    const before = await writeAndScroll(page)
    const sheet = page.getByTestId('bottom-sheet')
    for (const how of ['遮罩', 'Esc', '下滑', '关闭按钮'] as const) {
      await assistantButton(page).tap()
      await expect(sheet).toBeVisible()
      await page.waitForTimeout(600)
      if (how === '遮罩') await page.mouse.click(187, 120)
      else if (how === 'Esc') await page.keyboard.press('Escape')
      else if (how === '下滑') {
        const g = await headerCenter(page)
        await swipe(page, g, { x: g.x, y: g.y + 260 })
      } else await sheet.getByRole('button', { name: '关闭助手' }).tap()
      await expect(sheet).toHaveCount(0)
      await expect(assistantButton(page)).toBeFocused()
      expect(await editorState(page), `${how}关闭后`).toEqual(before)
    }
    await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
  })

  test('向上拖到全屏，再向下拖回半屏；输入框获得焦点时自动展开到全屏', async ({ page }) => {
    await openMobile(page)
    await assistantButton(page).tap()
    const sheet = page.getByTestId('bottom-sheet')
    await expect(sheet).toHaveAttribute('data-snap', 'half')
    await page.waitForTimeout(600)
    const half = await sheetTop(page)
    const g = await headerCenter(page)
    await swipe(page, g, { x: g.x, y: g.y - 260 })
    await expect(sheet).toHaveAttribute('data-snap', 'full')
    await page.waitForTimeout(600)
    const full = await sheetTop(page)
    expect(full).toBeLessThan(half - 150)
    expect(full).toBeLessThan(60)
    // 往回拖一小段：回到半屏，不会直接关闭
    const g2 = await headerCenter(page)
    await swipe(page, g2, { x: g2.x, y: g2.y + 200 }, 10, 24)
    await expect(sheet).toHaveAttribute('data-snap', 'half')
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(600)
    expect(Math.abs((await sheetTop(page)) - half)).toBeLessThan(4)
    // 点输入框：展开到全屏
    await sheet.getByTestId('agent-input').tap()
    await expect(sheet).toHaveAttribute('data-snap', 'full')
    await shot(page, 'agent-popup-mobile-full')
  })

  test('展开按钮：关闭面板，跳到整页助手', async ({ page }) => {
    await openMobile(page)
    await assistantButton(page).tap()
    await page.getByTestId('bottom-sheet').getByRole('button', { name: '展开到助手页' }).tap()
    await expect(page).toHaveURL(/\/agent$/)
    await expect(page.getByTestId('bottom-sheet')).toHaveCount(0)
    await expect(page.getByTestId('agent-panel')).toBeVisible()
  })

  test('减弱动态效果：面板不位移，淡入淡出', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openMobile(page)
    await page.evaluate(() => {
      const w = window as unknown as { __frames: { top: number; op: number }[] }
      w.__frames = []
      const tick = () => {
        const el = document.querySelector<HTMLElement>('[data-testid="bottom-sheet"]')
        if (el) w.__frames.push({ top: el.getBoundingClientRect().top, op: parseFloat(getComputedStyle(el).opacity) })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await assistantButton(page).tap()
    await expect(page.getByTestId('bottom-sheet')).toBeVisible()
    await page.waitForTimeout(600)
    const frames = await page.evaluate(() => (window as unknown as { __frames: { top: number; op: number }[] }).__frames)
    expect(frames.length).toBeGreaterThan(3)
    expect(Math.max(...frames.map((f) => f.top)) - Math.min(...frames.map((f) => f.top)), '面板位置没有变化').toBeLessThan(1)
    expect(frames[0].op).toBeLessThan(0.95)
    expect(frames.at(-1)!.op).toBeCloseTo(1, 1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('bottom-sheet')).toHaveCount(0)
  })
})

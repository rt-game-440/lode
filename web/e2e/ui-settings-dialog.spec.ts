import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #74：桌面端设置是居中浮窗（笔记页留在下面），手机端仍是全屏页面。
// 文件名排在 smoke.spec 之后（首次设置），在 ui-workspaces.spec 之前（它要求此前只有默认工作空间；本文件不建工作空间）。
// 设置 LODE_SCREENSHOTS=<目录名> 时截图：桌面浮窗第一级、子页面、深色模式。
const PASSWORD = 'e2e-test-password'
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''

let noteId = ''
let tokenId = ''
const NOTE_PATH = '设置浮窗测试.md'
const TOKEN_NAME = '设置浮窗测试'

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

async function open(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, ...opts })
  await signIn(c)
  return { c, p: await c.newPage() }
}

test.beforeAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行`).join('\n\n')
  const tree = await (await c.request.get('/api/tree')).json()
  const old = tree.notes.find((n: { path: string }) => n.path === NOTE_PATH)
  if (old) noteId = old.id
  else {
    const res = await c.request.post('/api/notes', { data: { path: NOTE_PATH, content: `# 设置浮窗\n\n${lines}\n` } })
    expect(res.ok()).toBe(true)
    noteId = (await res.json()).id
  }
  const t = await c.request.post('/api/tokens', { data: { name: TOKEN_NAME, scope: 'read' } })
  expect(t.ok()).toBe(true)
  tokenId = (await t.json()).token.id
  await c.close()
})

test.afterAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  await c.request.delete(`/api/tokens/${tokenId}`)
  await c.close()
})

const dialog = (p: Page) => p.getByTestId('settings-dialog')
const heading = (p: Page, name: string) => dialog(p).getByRole('heading', { name, level: 1, exact: true })
const scrollTop = (p: Page) => p.locator('.editor-scroll').evaluate((el) => Math.round(el.scrollTop))
const gear = (p: Page) => p.getByRole('button', { name: '设置', exact: true })

async function openNoteScrolled(p: Page) {
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('第 1 行')
  await p.locator('.editor-scroll').evaluate((el) => (el.scrollTop = 700))
  await p.waitForTimeout(200)
  const top = await scrollTop(p)
  expect(top).toBeGreaterThan(400)
  return top
}

test('1440：从笔记页打开是浮窗，笔记页还在下面；进入子页面再返回', async ({ browser }) => {
  const { c, p } = await open(browser)
  const top = await openNoteScrolled(p)
  await gear(p).click()
  await expect(dialog(p)).toBeVisible()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  // 笔记页还在下面，滚动位置不变
  await expect(p.locator('.cm-content')).toBeVisible()
  expect(await scrollTop(p)).toBe(top)
  // 浮窗居中，宽度和高度有上限（等入场动画结束再量）
  await p.waitForTimeout(600)
  const box = (await dialog(p).boundingBox())!
  expect(box.width).toBeLessThanOrEqual(721)
  expect(box.height).toBeLessThanOrEqual(900 * 0.8 + 1)
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(2)
  expect(Math.abs(box.y + box.height / 2 - 450)).toBeLessThan(2)
  // 焦点在浮窗里
  await expect(dialog(p)).toBeFocused()

  // 子页面：左右推入，返回按钮和 Backspace 返回
  await dialog(p).getByRole('link', { name: /^外观/ }).click()
  await expect(p).toHaveURL(/\/settings\/appearance$/)
  await expect(heading(p, '外观')).toBeVisible()
  await dialog(p).getByRole('button', { name: '返回设置' }).click()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  await dialog(p).getByRole('link', { name: /^编辑器/ }).click()
  await expect(heading(p, '编辑器')).toBeVisible()
  await p.keyboard.press('Backspace')
  await expect(p).toHaveURL(/\/settings$/)
  await dialog(p).getByRole('link', { name: /^键盘/ }).click()
  await expect(heading(p, '键盘')).toBeVisible()
  await p.keyboard.press('ControlOrMeta+[')
  await expect(p).toHaveURL(/\/settings$/)
  await c.close()
})

test('1440：Esc、点遮罩、关闭按钮都能关闭并回到原笔记，滚动位置不变，焦点回到齿轮', async ({ browser }) => {
  const { c, p } = await open(browser)
  const top = await openNoteScrolled(p)
  const back = async (how: string) => {
    await expect(dialog(p), how).toBeHidden()
    await expect(p, how).toHaveURL(new RegExp(`/note/${noteId}$`))
    expect(await scrollTop(p), how).toBe(top)
  }

  // Esc（在子页面里直接关闭浮窗，不是返回上一级）
  await gear(p).click()
  await dialog(p).getByRole('link', { name: /^外观/ }).click()
  await expect(heading(p, '外观')).toBeVisible()
  await p.keyboard.press('Escape')
  await back('Esc')
  await expect(gear(p)).toBeFocused()

  // 点遮罩
  await gear(p).click()
  await expect(dialog(p)).toBeVisible()
  await p.mouse.click(30, 450)
  await back('点遮罩')

  // 关闭按钮
  await gear(p).click()
  await dialog(p).getByTestId('settings-close').click()
  await back('关闭按钮')
  await expect(gear(p)).toBeFocused()

  // 点浮窗里面不关闭
  await gear(p).click()
  await dialog(p).getByTestId('settings-home').click({ position: { x: 5, y: 5 } })
  await expect(dialog(p)).toBeVisible()
  await c.close()
})

test('Tab 在浮窗内循环，不会跑到笔记页', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto(`/note/${noteId}`)
  await gear(p).click()
  await expect(dialog(p)).toBeFocused()
  for (let i = 0; i < 30; i++) {
    await p.keyboard.press('Tab')
    expect(await p.evaluate(() => !!document.activeElement?.closest('[data-testid="settings-dialog"]'))).toBe(true)
  }
  for (let i = 0; i < 30; i++) {
    await p.keyboard.press('Shift+Tab')
    expect(await p.evaluate(() => !!document.activeElement?.closest('[data-testid="settings-dialog"]'))).toBe(true)
  }
  await c.close()
})

test('直接访问 /settings/agent 打开浮窗在助手子页面；浏览器后退关闭浮窗', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/')
  await expect(dialog(p)).toBeHidden()
  await p.goto('/settings/agent')
  await expect(dialog(p)).toBeVisible()
  await expect(heading(p, '助手')).toBeVisible()
  // 浮窗在首页之上
  await expect(p.getByRole('heading', { name: /Lode|笔记/ }).first()).toBeAttached()
  await p.reload()
  await expect(heading(p, '助手')).toBeVisible()

  // 从笔记页逐级进入后，后退逐级返回，再后退关闭浮窗，回到笔记
  await p.goto(`/note/${noteId}`)
  await gear(p).click()
  await dialog(p).getByRole('link', { name: /^助手/ }).click()
  await expect(heading(p, '助手')).toBeVisible()
  await p.goBack()
  await expect(heading(p, '设置')).toBeVisible()
  await p.goBack()
  await expect(dialog(p)).toBeHidden()
  await expect(p).toHaveURL(new RegExp(`/note/${noteId}$`))
  await expect(p.locator('.cm-content')).toBeVisible()
  // 前进重新打开
  await p.goForward()
  await expect(dialog(p)).toBeVisible()

  // 关闭按钮一次退回打开前的地址，历史里不留设置的各级
  await dialog(p).getByRole('link', { name: /^外观/ }).click()
  await dialog(p).getByTestId('settings-close').click()
  await expect(dialog(p)).toBeHidden()
  await expect(p).toHaveURL(new RegExp(`/note/${noteId}$`))
  await c.close()
})

test('助手面板“打开设置”打开浮窗并定位到助手子页面；关闭后回到助手页', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/agent')
  const btn = p.getByRole('button', { name: '打开设置' })
  // 只有还没有可用模型时才有这个入口；被其他用例配置过供应商则跳过
  test.skip(!(await btn.isVisible().catch(() => false)), '已有模型，没有“打开设置”入口')
  await btn.click()
  await expect(dialog(p)).toBeVisible()
  await expect(heading(p, '助手')).toBeVisible()
  await p.keyboard.press('Escape')
  await expect(dialog(p)).toBeHidden()
  await expect(p).toHaveURL(/\/agent$/)
  await c.close()
})

test('浮窗里打开吊销确认框，Esc 只关闭确认框', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto(`/note/${noteId}`)
  await p.goto(`/settings/tokens/${tokenId}`)
  await expect(heading(p, TOKEN_NAME)).toBeVisible()
  await dialog(p).getByRole('button', { name: /吊销/ }).click()
  const confirm = p.getByRole('dialog', { name: /吊销/ })
  await expect(confirm).toBeVisible()
  await p.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(dialog(p)).toBeVisible()
  await expect(heading(p, TOKEN_NAME)).toBeVisible()
  // 再按一次 Esc 才关浮窗
  await dialog(p).focus()
  await p.keyboard.press('Escape')
  await expect(dialog(p)).toBeHidden()
  await c.close()
})

test('输入框里按 Esc 不关闭浮窗', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings/tokens')
  await expect(heading(p, 'API token')).toBeVisible()
  const input = dialog(p).getByRole('textbox').first()
  await input.focus()
  await p.keyboard.press('Escape')
  await expect(dialog(p)).toBeVisible()
  await c.close()
})

test('375：手机端仍是全屏设置页，没有浮窗', async ({ browser }) => {
  const { c, p } = await open(browser, { viewport: { width: 375, height: 812 }, hasTouch: true })
  await p.goto('/settings')
  await expect(p.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
  await expect(dialog(p)).toHaveCount(0)
  await expect(p.getByTestId('settings-home')).toBeVisible()
  await c.close()
})

test('768（平板）按桌面处理：显示浮窗', async ({ browser }) => {
  const { c, p } = await open(browser, { viewport: { width: 768, height: 1024 } })
  await p.goto('/settings')
  await expect(dialog(p)).toBeVisible()
  const box = (await dialog(p).boundingBox())!
  expect(box.width).toBeLessThanOrEqual(768)
  await c.close()
})

test('减弱动态效果：只淡入淡出，不缩放位移', async ({ browser }) => {
  const { c, p } = await open(browser, { reducedMotion: 'reduce' })
  await p.goto(`/note/${noteId}`)
  await gear(p).click()
  await expect(dialog(p)).toBeVisible()
  const transform = await dialog(p).evaluate((el) => getComputedStyle(el).transform)
  expect(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true)
  await p.keyboard.press('Escape')
  await expect(dialog(p)).toBeHidden()
  await c.close()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`axe：设置浮窗（${scheme}）没有 serious / critical 问题`, async ({ browser }) => {
    const { c, p } = await open(browser, { colorScheme: scheme })
    await p.goto(`/note/${noteId}`)
    await gear(p).click()
    await expect(dialog(p)).toBeVisible()
    await p.waitForTimeout(600)
    for (const path of ['', '/tokens']) {
      if (path) {
        await p.goto(`/settings${path}`)
        await expect(dialog(p)).toBeVisible()
        await p.waitForTimeout(600)
      }
      const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const bad = result.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}（${v.impact}）：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)
      expect(bad).toEqual([])
    }
    await c.close()
  })
}

test.describe('截图', () => {
  test.skip(!shotStage, '设置 LODE_SCREENSHOTS 时才截图')
  for (const scheme of ['light', 'dark'] as const) {
    test(`桌面浮窗（${scheme}）`, async ({ browser }) => {
      mkdirSync(shotDir, { recursive: true })
      const { c, p } = await open(browser, { colorScheme: scheme })
      await p.goto(`/note/${noteId}`)
      await expect(p.locator('.cm-content')).toContainText('第 1 行')
      await gear(p).click()
      await expect(heading(p, '设置')).toBeVisible()
      await p.waitForTimeout(700)
      await p.screenshot({ path: resolve(shotDir, `settings-dialog-home-${scheme}.png`) })
      await dialog(p).getByRole('link', { name: /^API token/ }).click()
      await expect(heading(p, 'API token')).toBeVisible()
      await p.waitForTimeout(700)
      await p.screenshot({ path: resolve(shotDir, `settings-dialog-tokens-${scheme}.png`) })
      await c.close()
    })
  }
})

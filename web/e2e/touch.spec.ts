import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// 阶段 3：手机上的跟手手势（左缘返回、右栏抽屉）。用 CDP 派发真实的触摸序列。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）。
// 设置 LODE_SCREENSHOTS=stage-3 时录制手势过程，输出到 docs/screenshots/stage-3/。
const PASSWORD = 'e2e-test-password'
const shotStage = process.env.LODE_SCREENSHOTS
const videoDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage, 'video') : ''

test.describe.configure({ mode: 'serial' })

let ctx: BrowserContext
let page: Page
let cdp: CDPSession
let noteId = ''

test.beforeAll(async ({ browser }) => {
  if (videoDir) mkdirSync(videoDir, { recursive: true })
  ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 375, height: 812 } } } : {}),
  })
  const status = await (await ctx.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await ctx.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await ctx.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  const res = await ctx.request.post('/api/notes', {
    data: { path: '手势/返回手势.md', content: '# 返回手势\n\n从屏幕左缘向右滑回到列表。\n\n参见 [[设计说明]] #手势' },
  })
  expect(res.ok()).toBe(true)
  noteId = (await res.json()).id
  // [[ 补全需要别的笔记作为候选
  await ctx.request.post('/api/notes', { data: { path: '手势/抽屉.md', content: '右栏抽屉的跟手拖拽。' } })
  page = await ctx.newPage()
  cdp = await ctx.newCDPSession(page)
})

test.afterAll(async () => {
  await ctx.close()
})

/** 一次触摸拖动：steps 次移动，每次间隔 stepMs。返回前 holdAt 回调可以在松手前检查中间状态。 */
async function swipe(from: { x: number; y: number }, to: { x: number; y: number }, steps: number, stepMs: number, holdAt?: () => Promise<void>) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
    await page.waitForTimeout(stepMs)
  }
  if (holdAt) await holdAt()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function translateX(selector: string) {
  return page.locator(selector).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
}

async function openNote() {
  await page.goto(`/note/${noteId}`)
  await expect(page.locator('.cm-content')).toContainText('从屏幕左缘')
  await page.waitForTimeout(500) // 等进入动画结束
}

test('左缘右滑：详情页跟手移动，快速滑过一半松手后返回列表', async () => {
  await openNote()
  await swipe({ x: 4, y: 420 }, { x: 154, y: 424 }, 10, 16, async () => {
    // 松手前：详情层跟着手指走了约 150px（锁定方向前的 10px 防抖之后 1:1 跟随）
    const x = await translateX('.mobile-layer.is-detail')
    expect(x).toBeGreaterThan(120)
    expect(x).toBeLessThanOrEqual(152)
  })
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('tree', { name: '笔记' })).toBeVisible()
})

test('左缘右滑：慢慢拖一小段后松手，弹回笔记页', async () => {
  await openNote()
  await swipe({ x: 4, y: 420 }, { x: 70, y: 420 }, 10, 40)
  await page.waitForTimeout(600)
  await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
  expect(Math.abs(await translateX('.mobile-layer.is-detail'))).toBeLessThan(1)
})

test('右栏抽屉：跟手拖拽，向右甩出关闭；拖一小段松手弹回', async () => {
  await openNote()
  await page.getByRole('button', { name: '显示右栏' }).click()
  const drawer = page.getByRole('dialog', { name: '笔记信息' })
  await expect(drawer).toBeVisible()
  await page.waitForTimeout(500)
  const box = (await drawer.boundingBox())!

  // 小幅慢拖：弹回
  await swipe({ x: box.x + 60, y: 400 }, { x: box.x + 110, y: 400 }, 10, 40, async () => {
    expect(await translateX('.drawer')).toBeGreaterThan(30)
  })
  await page.waitForTimeout(600)
  await expect(drawer).toBeVisible()
  expect(Math.abs(await translateX('.drawer'))).toBeLessThan(1)

  // 快速向右甩：关闭
  await swipe({ x: box.x + 60, y: 400 }, { x: box.x + 200, y: 400 }, 6, 16)
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('button', { name: '显示右栏' })).toBeVisible()
})

test('手机编辑工具栏：聚焦编辑器时出现，插入任务和笔记链接不收起键盘，收起键盘后隐藏', async () => {
  await openNote()
  const toolbar = page.getByRole('toolbar', { name: '插入 Markdown' })
  await expect(toolbar).toBeHidden()
  await page.locator('.cm-line').last().tap()
  await expect(toolbar).toBeVisible()

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('买牛奶')
  await toolbar.getByRole('button', { name: '任务' }).tap()
  await expect(page.locator('.cm-content')).toBeFocused()
  await toolbar.getByRole('button', { name: '笔记链接' }).tap()
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.locator('.cm-content').evaluate((el) => (el as HTMLElement).innerText)).toContain('买牛奶[[]]')
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true)

  await toolbar.getByRole('button', { name: '收起键盘' }).tap()
  await expect(toolbar).toBeHidden()
  // 保存后的文件内容：任务标记加在行首
  await expect(page.getByTestId('save-status')).toHaveText('已保存')
  const note = await (await ctx.request.get(`/api/notes/${noteId}`)).json()
  expect(note.content).toContain('- [ ] 买牛奶[[]]')
})

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// 阶段 3：手机上的跟手手势（左缘返回、右栏抽屉、右缘左滑拉出右栏）。用 CDP 派发真实的触摸序列。
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
let longId = ''

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
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：用来测试纵向滚动。`).join('\n\n')
  const long = await ctx.request.post('/api/notes', { data: { path: '手势/长笔记.md', content: `# 长笔记\n\n${lines}` } })
  expect(long.ok()).toBe(true)
  longId = (await long.json()).id
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

const touch = {
  down: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }),
  up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
}

/** 手指不抬起，从 from 分 steps 步移到 to，每步间隔 stepMs。 */
async function moveTo(from: { x: number; y: number }, to: { x: number; y: number }, steps: number, stepMs: number) {
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
    await page.waitForTimeout(stepMs)
  }
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
  await swipe({ x: 4, y: 420 }, { x: 224, y: 424 }, 10, 16, async () => {
    // 松手前：详情层从锁定方向的那一刻起 1:1 跟随手指（第一步 22px 用于方向锁定，之后又走了 198px），越过了屏幕一半
    const x = await translateX('.mobile-layer.is-detail')
    expect(x).toBeGreaterThan(190)
    expect(x).toBeLessThanOrEqual(200)
  })
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('tree', { name: '笔记' })).toBeVisible()
  // 手势之后的第一次点按照常生效（没有被浏览器当成“停住惯性”吞掉）
  await page.waitForTimeout(500)
  await page.getByRole('treeitem', { name: /返回手势/ }).tap()
  await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
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
  // 焦点移入抽屉，Tab 在抽屉内循环，不会跑到遮罩后面的页面
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
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
  // 甩完后的第一次点按照常生效（没有被浏览器当成“停住惯性”吞掉）
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '显示右栏' }).tap()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
})

// ---- 右缘左滑拉出右侧栏（#22） ----
// 视口宽 375，抽屉宽 min(300px, 88vw) = 300。起手点距右缘 30px，落在 56px 的起手窄带里。
const EDGE_X = 345
const DRAWER_W = 300

async function opacity(selector: string) {
  return page.locator(selector).evaluate((el) => Number(getComputedStyle(el).opacity))
}

test('右缘左滑：右侧栏 1:1 跟手拉出，中途反向往回拖，松手收回', async () => {
  await openNote()
  const drawer = page.getByRole('dialog', { name: '笔记信息' })
  await touch.down(EDGE_X, 420)
  await moveTo({ x: EDGE_X, y: 420 }, { x: EDGE_X - 160, y: 420 }, 8, 16)
  // 第一步 20px 用于方向锁定，之后又走了 140px：抽屉从右缘露出 140px，遮罩按比例变深
  await expect(drawer).toBeVisible()
  await expect.poll(() => translateX('.drawer')).toBeCloseTo(DRAWER_W - 140, 0)
  expect(await opacity('.drawer-scrim')).toBeCloseTo(140 / DRAWER_W, 1)
  // 中途反向：往回拖 60px，抽屉跟着缩回
  await moveTo({ x: EDGE_X - 160, y: 420 }, { x: EDGE_X - 100, y: 420 }, 3, 16)
  await expect.poll(() => translateX('.drawer')).toBeCloseTo(DRAWER_W - 80, 0)
  await touch.up()
  // 松手时手指正往回走（速度朝收回方向），露出的部分也不到一半：收回
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
  await expect(page.getByRole('button', { name: '显示右栏' })).toBeVisible()
})

test('右缘左滑：快速轻扫一小段就展开、慢慢拖过一半也展开；打开后在遮罩上右滑或点遮罩关闭', async () => {
  await openNote()
  const drawer = page.getByRole('dialog', { name: '笔记信息' })
  // 快速轻扫：第一步 30px 用于方向锁定，之后只拖了 90px（不到一半），按速度投射的落点越过一半，展开
  await swipe({ x: EDGE_X, y: 420 }, { x: EDGE_X - 120, y: 420 }, 4, 4)
  await expect(drawer).toBeVisible()
  await expect.poll(() => translateX('.drawer')).toBeCloseTo(0, 0)
  // 打开后焦点移入侧栏
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true)

  // 在遮罩上向右甩：抽屉跟手右移并关闭
  await swipe({ x: 30, y: 420 }, { x: 170, y: 420 }, 6, 16, async () => {
    expect(await translateX('.drawer')).toBeGreaterThan(60)
  })
  await expect(drawer).toBeHidden()

  // 慢慢拖过一半再松手：按位置展开
  await swipe({ x: EDGE_X, y: 420 }, { x: EDGE_X - 200, y: 420 }, 20, 40)
  await expect(drawer).toBeVisible()
  await expect.poll(() => translateX('.drawer')).toBeCloseTo(0, 0)
  // 点遮罩：关闭
  await page.touchscreen.tap(30, 420)
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/note/${noteId}$`))
})

test('右缘左滑：窄带外左滑、纵向滚动、长按后拖动选字、横向滚动的内容都不会拉出右侧栏', async () => {
  await page.goto(`/note/${longId}`)
  await expect(page.locator('.cm-content')).toContainText('第 1 行')
  await page.waitForTimeout(500)
  const noDrawer = async () => expect(await page.locator('.drawer').count()).toBe(0)
  const scroller = page.locator('.mobile-layer.is-detail .editor-scroll')

  // 起点在窄带外（距右缘 75px）：不接管
  await swipe({ x: 300, y: 420 }, { x: 120, y: 420 }, 6, 16, noDrawer)
  await page.waitForTimeout(300)
  await noDrawer()

  // 窄带里纵向滑动（略带横向）：编辑区照常滚动
  await swipe({ x: EDGE_X, y: 650 }, { x: EDGE_X - 15, y: 300 }, 10, 16, noDrawer)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  await page.waitForTimeout(300)
  await noDrawer()

  // 长按后再横向拖动（拖动选字）：不接管
  await touch.down(EDGE_X, 420)
  await page.waitForTimeout(800)
  await moveTo({ x: EDGE_X, y: 420 }, { x: EDGE_X - 150, y: 424 }, 10, 16)
  await noDrawer()
  await touch.up()
  await page.waitForTimeout(300)
  await noDrawer()

  // 能横向滚动的内容（宽表格、代码块）：横向拖动滚动它本身，不拉出侧栏
  await page.goto(`/note/${longId}`)
  await expect(page.locator('.cm-content')).toContainText('第 1 行')
  await page.waitForTimeout(500)
  await scroller.evaluate((el) => {
    const wide = document.createElement('div')
    wide.className = 'e2e-hscroll'
    wide.style.cssText = 'flex: none; height: 120px; overflow-x: auto; white-space: nowrap; font-size: 20px'
    wide.textContent = '宽表格的一行 '.repeat(80)
    el.prepend(wide)
    el.scrollTop = 0
  })
  const wide = page.locator('.e2e-hscroll')
  const box = (await wide.boundingBox())!
  await swipe({ x: EDGE_X, y: box.y + 60 }, { x: EDGE_X - 200, y: box.y + 60 }, 8, 16, noDrawer)
  await expect.poll(() => wide.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50)
  await page.waitForTimeout(300)
  await noDrawer()
  await wide.evaluate((el) => el.remove())
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

test('减弱动态效果：右缘左滑时右侧栏不位移，透明度跟随拉出比例；松手后淡入到位，点遮罩淡出', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await openNote() // 重新加载页面，useReducedMotion 读到新的设置
    const drawer = page.getByRole('dialog', { name: '笔记信息' })
    await touch.down(EDGE_X, 420)
    await moveTo({ x: EDGE_X, y: 420 }, { x: EDGE_X - 160, y: 420 }, 8, 16)
    await expect(drawer).toBeVisible()
    await expect.poll(() => opacity('.drawer')).toBeCloseTo(140 / DRAWER_W, 1)
    expect(await translateX('.drawer')).toBe(0)
    await moveTo({ x: EDGE_X - 160, y: 420 }, { x: EDGE_X - 260, y: 420 }, 5, 16)
    await touch.up()
    await expect.poll(() => opacity('.drawer')).toBe(1)
    expect(await translateX('.drawer')).toBe(0)

    // 点遮罩关闭：逐帧采样，抽屉始终不位移，透明度有中间值（淡出而不是直接消失）
    await page.evaluate(() => {
      const w = window as unknown as { __drawer: { t: string; o: number }[] }
      w.__drawer = []
      const end = performance.now() + 600
      const tick = () => {
        const el = document.querySelector('.drawer')
        if (el) {
          const cs = getComputedStyle(el)
          w.__drawer.push({ t: cs.transform, o: Number(cs.opacity) })
        }
        if (performance.now() < end) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.touchscreen.tap(30, 420)
    await expect(drawer).toBeHidden()
    await page.waitForTimeout(400)
    const samples = await page.evaluate(() => (window as unknown as { __drawer: { t: string; o: number }[] }).__drawer)
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.filter((x) => x.t !== 'none' && x.t !== 'matrix(1, 0, 0, 1, 0, 0)')).toEqual([])
    expect(samples.some((x) => x.o > 0.05 && x.o < 0.95)).toBe(true)
  } finally {
    await page.emulateMedia({ reducedMotion: null })
  }
})

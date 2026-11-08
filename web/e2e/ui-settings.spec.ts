import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #23：设置改成 iOS“设置”式的多级页面。首页分组列表、逐级进入和返回（返回按钮、浏览器后退、手机左缘手势）、
// 每级有自己的地址、刷新停在原页面、转场遵守减弱动态效果。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码），在 visual.spec 之前。
// 设置 LODE_SCREENSHOTS=<目录名> 时截取桌面端和手机端的设置页面，输出到 docs/screenshots/<目录名>/。
const PASSWORD = 'e2e-test-password'
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''

let tokenId = ''
const TOKEN_NAME = '设置导航测试'

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

const heading = (p: Page, name: string) => p.getByRole('heading', { name, level: 1, exact: true })

test.beforeAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  const res = await c.request.post('/api/tokens', { data: { name: TOKEN_NAME, scope: 'read' } })
  expect(res.ok()).toBe(true)
  tokenId = (await res.json()).token.id
  await c.close()
})

test('设置首页是分组列表，每行有图标、名称、状态摘要和 ›', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings')
  await expect(heading(p, '设置')).toBeVisible()
  const home = p.getByTestId('settings-home')
  for (const g of ['通用', '助手', 'agent 接入']) await expect(home.getByRole('heading', { name: g, level: 2 })).toBeVisible()

  const row = (name: string) => home.getByRole('link', { name: new RegExp(`^${name}`) })
  await expect(row('外观')).toContainText('跟随系统')
  await expect(row('键盘')).toContainText(/\d+ 个快捷键/)
  await expect(row('助手')).toContainText(/未配置|\d+ 个供应商/)
  await expect(row('MCP 接入')).toContainText(`${new URL(p.url()).host}/mcp`)
  await expect(row('API token')).toContainText(/\d+ 个/)
  await expect(row('调用记录')).toContainText(/暂无|最近/)
  // 每行都是链接，有图标和 ›
  const links = home.getByRole('link')
  await expect(links).toHaveCount(6)
  for (const l of await links.all()) {
    await expect(l.locator('.row-icon')).toHaveCount(1)
    await expect(l.locator('.nav-row-chevron')).toHaveCount(1)
  }
  await c.close()
})

test('逐级进入和返回：返回按钮、浏览器后退和前进都逐级走，地址和焦点跟着变', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings')
  await expect(heading(p, '设置')).toBeVisible()

  // 第一级 → API token：焦点移到新页面的标题
  await p.getByRole('link', { name: /^API token/ }).click()
  await expect(p).toHaveURL(/\/settings\/tokens$/)
  await expect(heading(p, 'API token')).toBeVisible()
  await expect(p.locator(':focus')).toHaveText('API token')
  // API token → 单个 token（第三级）
  await p.getByRole('list', { name: 'API token 列表' }).getByRole('link', { name: new RegExp(TOKEN_NAME) }).click()
  await expect(p).toHaveURL(new RegExp(`/settings/tokens/${tokenId}$`))
  await expect(heading(p, TOKEN_NAME)).toBeVisible()
  await expect(p.getByTestId('token-detail')).toContainText('只读')

  // 返回按钮显示上一级的标题，逐级返回
  await p.getByRole('button', { name: '返回API token' }).click()
  await expect(p).toHaveURL(/\/settings\/tokens$/)
  await expect(heading(p, 'API token')).toBeVisible()
  // 浏览器后退（Android 返回键同样触发 popstate）
  await p.goBack()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  // 返回后焦点回到进入前点的那一行
  await expect(p.locator(':focus')).toHaveAttribute('href', '/settings/tokens')
  // 前进再次推入
  await p.goForward()
  await expect(p).toHaveURL(/\/settings\/tokens$/)
  await expect(heading(p, 'API token')).toBeVisible()
  // 返回按钮走浏览器历史：不会在历史里多出一条首页记录
  await p.getByRole('button', { name: '返回设置' }).click()
  await expect(p).toHaveURL(/\/settings$/)
  await p.goForward()
  await expect(p).toHaveURL(/\/settings\/tokens$/)
  await c.close()
})

test('子页面地址可以直接打开，刷新后停在原页面，返回按钮逐级回到首页', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto(`/settings/tokens/${tokenId}`)
  await expect(heading(p, TOKEN_NAME)).toBeVisible()
  await p.reload()
  await expect(heading(p, TOKEN_NAME)).toBeVisible()
  await expect(p).toHaveURL(new RegExp(`/settings/tokens/${tokenId}$`))
  // 直接打开时历史里没有上一级：返回按钮替换当前地址
  await p.getByRole('button', { name: '返回API token' }).click()
  await expect(p).toHaveURL(/\/settings\/tokens$/)
  await expect(heading(p, 'API token')).toBeVisible()
  await p.getByRole('button', { name: '返回设置' }).click()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()

  for (const [path, title] of [
    ['appearance', '外观'],
    ['keyboard', '键盘'],
    ['agent', '助手'],
    ['mcp', 'MCP 接入'],
    ['audit', '调用记录'],
  ]) {
    await p.goto(`/settings/${path}`)
    await expect(heading(p, title)).toBeVisible()
    await p.reload()
    await expect(heading(p, title)).toBeVisible()
  }
  // 不存在的地址：提示并可以返回
  await p.goto('/settings/nope')
  await expect(p.getByText('找不到这个设置页面')).toBeVisible()
  await p.getByRole('button', { name: '返回设置' }).click()
  await expect(heading(p, '设置')).toBeVisible()
  await c.close()
})

test('外观：切换主题后首页摘要跟着变；键盘：列出快捷键并能打开快捷键弹窗', async ({ browser }) => {
  const { c, p } = await open(browser)
  await p.goto('/settings')
  await p.getByRole('link', { name: /^外观/ }).click()
  const themes = p.getByRole('radiogroup', { name: '主题' })
  await expect(themes.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
  await themes.getByRole('radio', { name: '深色' }).click()
  await expect(themes.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark')
  await p.getByRole('button', { name: '返回设置' }).click()
  await expect(p.getByRole('link', { name: /^外观/ })).toContainText('深色')

  await p.getByRole('link', { name: /^键盘/ }).click()
  await expect(heading(p, '键盘')).toBeVisible()
  await expect(p.locator('.shortcut-row').first()).toBeVisible()
  await p.getByRole('button', { name: '在弹窗中查看快捷键' }).click()
  await expect(p.getByRole('dialog')).toBeVisible()
  await p.keyboard.press('Escape')
  await expect(p.getByRole('dialog')).toHaveCount(0)
  await c.close()
})

/* ---------------- 转场 ---------------- */

type Sample = { t: string; o: number; n: number }

/** 接下来 ms 毫秒里每帧记录最上面一层的 transform、opacity 和层数。 */
async function sampleTop(p: Page, trigger: () => Promise<void>, ms = 700): Promise<Sample[]> {
  await p.evaluate((dur) => {
    const w = window as unknown as { __s: Sample[] }
    w.__s = []
    const end = performance.now() + dur
    const tick = () => {
      const layers = document.querySelectorAll('.settings-stack > .settings-layer')
      const el = layers[layers.length - 1]
      if (el) {
        const cs = getComputedStyle(el)
        w.__s.push({ t: cs.transform, o: Number(cs.opacity), n: layers.length })
      }
      if (performance.now() < end) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ms)
  await trigger()
  await p.waitForTimeout(ms + 100)
  return p.evaluate(() => (window as unknown as { __s: Sample[] }).__s)
}
/** computed transform（none、matrix() 或 matrix3d()）里的横向位移。 */
function shiftX(t: string) {
  const m = /^matrix(3d)?\((.+)\)$/.exec(t)
  if (!m) return 0
  const v = m[2].split(',').map(Number)
  return m[1] ? v[12] : v[4]
}

for (const reduce of [false, true]) {
  test(`${reduce ? '减弱动态效果时转场改为淡入淡出' : '正常情况下子页面从右侧推入、向右推出'}`, async ({ browser }) => {
    const { c, p } = await open(browser, { reducedMotion: reduce ? 'reduce' : 'no-preference' })
    await p.goto('/settings')
    await expect(heading(p, '设置')).toBeVisible()
    const push = await sampleTop(p, () => p.getByRole('link', { name: /^API token/ }).click())
    await expect(heading(p, 'API token')).toBeVisible()
    const pop = await sampleTop(p, () => p.getByRole('button', { name: '返回设置' }).click())
    await expect(heading(p, '设置')).toBeVisible()
    const moving = (s: Sample[]) => s.filter((x) => shiftX(x.t) > 1)
    const fading = (s: Sample[]) => s.filter((x) => x.o > 0.01 && x.o < 0.99)
    expect(push.length, '采样不为空').toBeGreaterThan(5)
    if (reduce) {
      // 不位移，只有透明度的中间帧
      expect(moving(push)).toEqual([])
      expect(moving(pop)).toEqual([])
      expect(fading(push).length).toBeGreaterThan(0)
      expect(fading(pop).length).toBeGreaterThan(0)
    } else {
      // 推入：从右往左的多个中间位置；推出：退出的那一层向右移出
      expect(new Set(moving(push).map((x) => x.t)).size).toBeGreaterThan(3)
      expect(new Set(moving(pop).map((x) => x.t)).size).toBeGreaterThan(3)
      expect(fading(push)).toEqual([])
    }
    // 动画结束后只剩当前页面这一层可见、没有残留位移
    const last = pop[pop.length - 1]
    expect(last.n).toBe(1)
    expect(shiftX(last.t)).toBe(0)
    await c.close()
  })
}

/* ---------------- 手机 ---------------- */

test('手机：左缘右滑和浏览器后退都只返回一级，回到设置首页后再滑回到笔记列表', async ({ browser }) => {
  const { c, p } = await open(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  const cdp = await c.newCDPSession(p)
  async function swipe(from: number, to: number, holdAt?: () => Promise<void>) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y: 420, id: 1 }] })
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + ((to - from) * i) / 10, y: 422, id: 1 }] })
      await p.waitForTimeout(16)
    }
    if (holdAt) await holdAt()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  await p.goto('/')
  await p.getByRole('button', { name: '设置' }).tap()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  await p.waitForTimeout(500)
  await p.getByRole('link', { name: /^API token/ }).tap()
  await expect(heading(p, 'API token')).toBeVisible()
  await p.waitForTimeout(500)
  // 子页面上外层“返回笔记列表”的手势区让位给设置自己的返回手势
  await expect(p.getByTestId('edge-swipe')).toBeHidden()
  await expect(p.getByTestId('settings-edge-swipe')).toBeVisible()

  await swipe(4, 224, async () => {
    // 松手前页面跟着手指走
    const x = await p.locator('.settings-stack > .settings-layer').last().evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
    expect(x).toBeGreaterThan(150)
    // 停一下再松手（按越过一半的距离返回）：Chrome 的模拟触摸在快速甩动后会吞掉紧接着的一次轻点
    await p.waitForTimeout(200)
  })
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  await p.waitForTimeout(600)

  // 浏览器后退（Android 返回键）同样只返回一级
  await p.getByRole('link', { name: /^MCP 接入/ }).tap()
  await expect(heading(p, 'MCP 接入')).toBeVisible()
  await p.goBack()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(heading(p, '设置')).toBeVisible()
  await p.waitForTimeout(600)

  // 设置首页：外层手势恢复，右滑回到笔记列表
  await expect(p.getByTestId('edge-swipe')).toBeVisible()
  await swipe(4, 224)
  await expect(p).not.toHaveURL(/\/settings/)
  await expect(p.getByRole('tablist', { name: '侧栏视图' })).toBeVisible()
  await c.close()
})

/* ---------------- 截图（人工查看） ---------------- */

test('截图：桌面端和手机端的设置页面', async ({ browser }) => {
  test.skip(!shotDir, '设置 LODE_SCREENSHOTS 后才截图')
  test.setTimeout(90_000)
  mkdirSync(shotDir, { recursive: true })
  // 没有供应商时建一个（只用于截图的测试 key，不会真的请求）
  const seed = await browser.newContext()
  await signIn(seed)
  const config = await (await seed.request.get('/api/agent/config')).json()
  if (!config.providers?.length) {
    const res = await seed.request.post('/api/agent/providers', {
      data: { name: '示例供应商', kind: 'openai', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-mock-e2e-1234' },
    })
    expect(res.ok()).toBe(true)
    const provider = await res.json()
    const model = { enabled: true, context_window: 128000, max_output: 8192, reasoning: false, effort: 'off', modalities: ['text'], tools: true, temperature: null }
    for (const id of ['example-large', 'example-small'])
      expect((await seed.request.post(`/api/agent/providers/${provider.id}/models`, { data: { ...model, model: id, name: id } })).ok()).toBe(true)
  }
  await seed.close()
  for (const scheme of ['light', 'dark'] as const) {
    for (const size of ['desktop', 'mobile'] as const) {
      const { c, p } = await open(browser, {
        colorScheme: scheme,
        ...(size === 'desktop'
          ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
          : { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }),
      })
      const pages: [string, string, string][] = [
        ['home', '/settings', '设置'],
        ['appearance', '/settings/appearance', '外观'],
        ['keyboard', '/settings/keyboard', '键盘'],
        ['agent', '/settings/agent', '助手'],
        ['mcp', '/settings/mcp', 'MCP 接入'],
        ['tokens', '/settings/tokens', 'API token'],
        ['token', `/settings/tokens/${tokenId}`, TOKEN_NAME],
        ['audit', '/settings/audit', '调用记录'],
      ]
      for (const [name, url, title] of pages) {
        await p.goto(url)
        await expect(heading(p, title)).toBeVisible()
        await p.waitForTimeout(400)
        await p.screenshot({ path: resolve(shotDir, `${size}-${scheme}-${name}.png`) })
      }
      // 第一个供应商的页面（第三级）
      await p.goto('/settings/agent')
      await p.getByTestId('provider-row').first().click()
      await expect(p.getByTestId('provider-card')).toBeVisible()
      await p.waitForTimeout(600)
      await p.screenshot({ path: resolve(shotDir, `${size}-${scheme}-provider.png`) })
      // 推入转场的中间帧
      await p.goto('/settings')
      await expect(heading(p, '设置')).toBeVisible()
      await p.waitForTimeout(400)
      await p.getByRole('link', { name: /^API token/ }).click()
      await p.waitForTimeout(90)
      await p.screenshot({ path: resolve(shotDir, `${size}-${scheme}-push-mid.png`) })
      await c.close()
    }
  }
})

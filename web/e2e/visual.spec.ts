import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// 阶段 3：无障碍扫描、减弱动态效果、多宽度布局、文件树虚拟滚动。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）；
// 虚拟滚动用例会写入 2500 篇笔记，必须是整个 e2e 的最后一个用例。
const PASSWORD = 'e2e-test-password'
const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')

async function signIn(c: BrowserContext) {
  const status = await (await c.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await c.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

let noteId = ''

test.beforeAll(async ({ browser }) => {
  const c = await browser.newContext()
  await signIn(c)
  const tree = await (await c.request.get('/api/tree')).json()
  const existing = tree.notes.find((n: { path: string }) => n.path === '视觉检查/设计说明.md')
  if (existing) noteId = existing.id
  else {
    const res = await c.request.post('/api/notes', {
      data: {
        path: '视觉检查/设计说明.md',
        content: '# 设计说明\n\n- [ ] 检查对比度\n- [x] 检查焦点环\n\n参见 [[欢迎]]，标签 #设计\n\n```ts\nconst a = 1\n```\n',
      },
    })
    expect(res.ok()).toBe(true)
    noteId = (await res.json()).id
  }
  await c.close()
})

async function signedIn(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', ...opts })
  await signIn(c)
  return c
}

/* ---------------- 1. axe 扫描 ---------------- */

type PageKind = 'setup' | 'login' | 'main' | 'settings' | 'settings-tokens' | 'settings-agent'

async function openPage(browser: Browser, kind: PageKind, scheme: 'light' | 'dark') {
  if (kind === 'setup' || kind === 'login') {
    // 不带 cookie 的新 context：实例已经设置过密码，所以首启页用模拟的状态接口渲染
    const c = await browser.newContext({ locale: 'zh-CN', colorScheme: scheme })
    const p = await c.newPage()
    if (kind === 'setup') {
      await p.route('**/api/auth/status', (r) => r.fulfill({ json: { initialized: false, authenticated: false } }))
    }
    await p.goto('/')
    await expect(p.getByRole('heading', { name: kind === 'setup' ? '欢迎使用 Lode' : '登录 Lode' })).toBeVisible()
    return { c, p }
  }
  const c = await signedIn(browser, { colorScheme: scheme })
  const p = await c.newPage()
  if (kind === 'main') {
    await p.goto(`/note/${noteId}`)
    await expect(p.locator('.cm-content')).toContainText('检查对比度')
  } else {
    // 设置首页和两个子页面（#23 起设置是多级页面）
    const [url, heading] = SETTINGS_PAGES[kind]
    await p.goto(url)
    await expect(p.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
  }
  return { c, p }
}

const SETTINGS_PAGES = {
  settings: ['/settings', '设置'],
  'settings-tokens': ['/settings/tokens', 'API token'],
  'settings-agent': ['/settings/agent', '助手'],
} as const

for (const scheme of ['light', 'dark'] as const) {
  for (const kind of ['setup', 'login', 'main', 'settings', 'settings-tokens', 'settings-agent'] as const) {
    test(`axe：${kind} ${scheme} 没有 serious / critical 问题`, async ({ browser }) => {
      const { c, p } = await openPage(browser, kind, scheme)
      await p.waitForTimeout(500) // 等入场动画结束，避免半透明中间态影响对比度计算
      const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const bad = result.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}（${v.impact}）：${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join('；')}`)
      expect(bad).toEqual([])
      await c.close()
    })
  }
}

/* ---------------- 2. 减弱动态效果 ---------------- */

/** 在接下来的 ms 毫秒里每帧记录 selector 元素的 transform，返回出现过的不同取值。 */
async function sampleTransforms(p: Page, selector: string, trigger: () => Promise<void>, ms = 700) {
  await p.evaluate(
    ([sel, dur]) => {
      const w = window as unknown as { __samples: string[] }
      w.__samples = []
      const end = performance.now() + (dur as number)
      const tick = () => {
        const el = document.querySelector(sel as string)
        if (el) w.__samples.push(getComputedStyle(el).transform)
        if (performance.now() < end) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [selector, ms],
  )
  await trigger()
  await p.waitForTimeout(ms + 100)
  const samples = await p.evaluate(() => (window as unknown as { __samples: string[] }).__samples)
  return [...new Set(samples)]
}

for (const reduce of [false, true]) {
  test(`${reduce ? '减弱动态效果时' : '正常情况下'}侧栏和快速切换器${reduce ? '没有' : '有'}位移动画`, async ({ browser }) => {
    const c = await signedIn(browser, { reducedMotion: reduce ? 'reduce' : 'no-preference', viewport: { width: 1280, height: 800 } })
    const p = await c.newPage()
    await p.goto(`/note/${noteId}`)
    await expect(p.locator('.cm-content')).toContainText('检查对比度')
    await p.locator('.editor-crumb').click() // 焦点离开编辑器，快捷键走全局处理

    const sidebar = await sampleTransforms(p, '[data-testid="shell-sidebar"]', () => p.keyboard.press('Control+Backslash'))
    const switcher = await sampleTransforms(p, '.switcher', () => p.keyboard.press('Control+k'))
    await p.keyboard.press('Escape')
    if (reduce) {
      // 只有起点和终点两个取值，没有中间帧；切换器始终不缩放、不位移
      expect(sidebar.length).toBeLessThanOrEqual(2)
      expect(switcher.length, '切换器出现过（采样不为空）').toBeGreaterThan(0)
      expect(switcher.filter((t) => t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)')).toEqual([])
    } else {
      // 对照组：同样的采样方法能看到中间帧，说明上面的断言不是空转
      expect(sidebar.length).toBeGreaterThan(3)
      expect(switcher.length).toBeGreaterThan(2)
    }
    await c.close()
  })
}

/* ---------------- 3. 三种宽度下的布局 ---------------- */

/** 页面上的横向滚动和可交互元素重叠（被滚动容器裁掉、inert、不可见的元素不算）。 */
function layoutProblems() {
  const problems: string[] = []
  const root = document.documentElement
  if (root.scrollWidth > root.clientWidth + 1) problems.push(`页面横向滚动：${root.scrollWidth} > ${root.clientWidth}`)
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    const ox = getComputedStyle(el).overflowX
    if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.closest('[inert]')) {
      if (el.matches('.mobile-toolbar, .cm-scroller')) continue // 工具栏、代码块允许横向滚动
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      problems.push(`横向滚动：${describe(el)} ${el.scrollWidth} > ${el.clientWidth}`)
    }
  }

  const sel = 'button, a[href], input:not([type=hidden]), textarea, select, [role="treeitem"], [role="tab"], [role="option"], [role="menuitem"]'
  const items: { el: HTMLElement; r: DOMRect }[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
    if (el.closest('[inert], [hidden]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
    const r = clip(el)
    if (r && r.width > 1 && r.height > 1) items.push({ el, r })
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w > 1 && h > 1) problems.push(`重叠：${describe(a.el)} 与 ${describe(b.el)}`)
    }
  }
  return { problems, checked: items.length }

  function clip(el: HTMLElement): DOMRect | null {
    let r = el.getBoundingClientRect()
    let left = Math.max(r.left, 0)
    let top = Math.max(r.top, 0)
    let right = Math.min(r.right, innerWidth)
    let bottom = Math.min(r.bottom, innerHeight)
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
      r = p.getBoundingClientRect()
      left = Math.max(left, r.left)
      top = Math.max(top, r.top)
      right = Math.min(right, r.right)
      bottom = Math.min(bottom, r.bottom)
    }
    return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null
  }
  function describe(el: HTMLElement) {
    const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? ''
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}「${name}」`
  }
}

for (const width of [375, 768, 1440]) {
  test(`宽度 ${width}：各页面没有横向滚动、可交互元素不重叠`, async ({ browser }) => {
    const mobile = width < 768
    const c = await signedIn(browser, {
      viewport: { width, height: mobile ? 812 : 900 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    })
    const p = await c.newPage()
    const pages: [string, string, () => Promise<void>][] = [
      ['首页', '/', async () => void (await expect(p.getByRole('tree', { name: '笔记' })).toBeVisible())],
      ['笔记', `/note/${noteId}`, async () => void (await expect(p.locator('.cm-content')).toContainText('检查对比度'))],
      ['设置', '/settings', async () => void (await expect(p.getByRole('heading', { name: '设置', level: 1 })).toBeVisible())],
      ['设置 API token', '/settings/tokens', async () => void (await expect(p.getByRole('heading', { name: 'API token', level: 1 })).toBeVisible())],
      ['设置 助手', '/settings/agent', async () => void (await expect(p.getByRole('heading', { name: '助手', level: 1 })).toBeVisible())],
      ['回收站', '/trash', async () => void (await expect(p.getByRole('heading', { name: '回收站' })).toBeVisible())],
      [
        '标签',
        '/',
        async () => {
          await p.getByRole('tab', { name: '标签' }).click()
          await expect(p.getByRole('tab', { name: '标签' })).toHaveAttribute('aria-selected', 'true')
        },
      ],
    ]
    const all: string[] = []
    for (const [name, url, ready] of pages) {
      await p.goto(url)
      await ready()
      await p.waitForTimeout(600)
      const { problems, checked } = await p.evaluate(layoutProblems)
      all.push(...problems.map((x) => `${name}：${x}`))
      // 确认检查确实覆盖到了可交互元素，不是空转
      expect(checked, `${name} 参与重叠检查的元素数`).toBeGreaterThan(0)
    }
    // 登录页（不带 cookie）
    const anon = await browser.newContext({ viewport: { width, height: 800 } })
    const lp = await anon.newPage()
    await lp.goto('/')
    await expect(lp.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
    await lp.waitForTimeout(600) // 等入场淡入结束，否则半透明的元素不参与检查
    const login = await lp.evaluate(layoutProblems)
    all.push(...login.problems.map((x) => `登录：${x}`))
    expect(login.checked).toBeGreaterThan(0)
    // 首启页（模拟尚未设置密码）
    await lp.route('**/api/auth/status', (r) => r.fulfill({ json: { initialized: false, authenticated: false } }))
    await lp.goto('/')
    await expect(lp.getByRole('heading', { name: '欢迎使用 Lode' })).toBeVisible()
    await lp.waitForTimeout(600)
    const setup = await lp.evaluate(layoutProblems)
    all.push(...setup.problems.map((x) => `首启：${x}`))
    expect(setup.checked).toBeGreaterThan(0)
    await anon.close()

    expect(all).toEqual([])
    await c.close()
  })
}

/** 触控设备上小于 44×44 的可点区域。用 ::after 扩大点击区域的按钮按伪元素的尺寸计算。 */
function smallTargets() {
  const MIN = 43.5
  const sel = 'button, a[href], input:not([type=hidden]), select, [role="treeitem"], [role="tab"], [role="option"], [role="menuitem"]'
  const out: string[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
    if (el.closest('[inert], [hidden]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
    // 正文里的任务复选框是行内控件（WCAG 2.5.8 行内例外），扩到 44px 会盖住相邻行
    if (el.closest('.cm-content')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    let w = r.width
    let h = r.height
    const after = getComputedStyle(el, '::after')
    if (after.content !== 'none' && after.position === 'absolute') {
      w = Math.max(w, parseFloat(after.width) || 0)
      h = Math.max(h, parseFloat(after.height) || 0)
    }
    if (w < MIN || h < MIN) {
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 16) ?? ''
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}「${name}」${Math.round(w)}×${Math.round(h)}`)
    }
  }
  return out
}

test('手机上可点区域不小于 44×44', async ({ browser }) => {
  const c = await signedIn(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  const p = await c.newPage()
  expect(await p.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  const all: string[] = []
  const check = async (name: string) => all.push(...(await p.evaluate(smallTargets)).map((x) => `${name}：${x}`))

  await p.goto('/')
  await expect(p.getByRole('tree', { name: '笔记' })).toBeVisible()
  await check('首页')
  await p.goto(`/note/${noteId}`)
  await p.locator('.cm-line').first().tap()
  await expect(p.getByRole('toolbar', { name: '插入 Markdown' })).toBeVisible()
  await p.waitForTimeout(500)
  await check('笔记（编辑中）')
  for (const [name, url, heading] of [
    ['设置', '/settings', '设置'],
    ['设置 API token', '/settings/tokens', 'API token'],
    ['设置 助手', '/settings/agent', '助手'],
    ['设置 外观', '/settings/appearance', '外观'],
  ]) {
    await p.goto(url)
    await expect(p.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await p.waitForTimeout(300)
    await check(name)
  }
  await p.goto('/trash')
  await expect(p.getByRole('heading', { name: '回收站' })).toBeVisible()
  await check('回收站')

  expect(all).toEqual([])
  await c.close()
})

/* ---------------- 4. 文件树虚拟滚动（最后一个用例） ---------------- */

test('文件树超过 2000 项时虚拟滚动，键盘导航能走到未渲染的行', async ({ browser }) => {
  test.setTimeout(120_000)
  const dir = join(vault, '大量笔记')
  mkdirSync(dir, { recursive: true })
  const N = 2500
  for (let i = 0; i < N; i++) writeFileSync(join(dir, `笔记 ${String(i).padStart(4, '0')}.md`), `第 ${i} 篇`)

  const c = await signedIn(browser, { viewport: { width: 1280, height: 800 } })
  await expect
    .poll(async () => (await (await c.request.get('/api/tree')).json()).notes.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(N)
  const p = await c.newPage()
  await p.goto('/')
  await p.evaluate(() => localStorage.setItem('lode.expanded', JSON.stringify(['大量笔记'])))
  await p.reload()
  const tree = p.getByRole('tree', { name: '笔记' })
  await expect(tree.getByRole('treeitem', { name: '笔记 0000' })).toBeVisible()

  // 只渲染了可见的一小部分
  const rendered = await tree.getByRole('treeitem').count()
  expect(rendered).toBeLessThan(150)

  // 滚到底部能看到最后一篇
  await p.locator('.sidebar-body').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(tree.getByRole('treeitem', { name: `笔记 ${N - 1}` })).toBeVisible()

  // 回到顶部，用键盘往下走 80 行：目标行原本不在渲染范围内，焦点仍然跟过去
  await p.locator('.sidebar-body').evaluate((el) => (el.scrollTop = 0))
  await tree.getByRole('treeitem', { name: '笔记 0000' }).focus()
  for (let i = 0; i < 80; i++) await p.keyboard.press('ArrowDown')
  await expect(p.locator(':focus')).toHaveAttribute('data-path', '大量笔记/笔记 0080.md')
  await expect(p.locator(':focus')).toBeInViewport()
  await c.close()
})

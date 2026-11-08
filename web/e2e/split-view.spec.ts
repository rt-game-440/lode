import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// 桌面三栏的侧栏 / 右栏展开收起（#18）：每一帧采样主区域、两侧面板边缘、正文列和标题栏右侧三个按钮，
// 检查主区域贴着面板边缘移动、按钮始终可见、正文没有单帧跳变，以及拖拽调宽和减弱动态效果。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）。
const PASSWORD = 'e2e-test-password'
const VIEWPORT = { width: 1280, height: 800 }

interface Layout {
  sidebarOpen: boolean
  rightOpen: boolean
}

interface Frame {
  mainL: number
  mainR: number
  /** 侧栏右缘；侧栏隐藏时为 null */
  sbR: number | null
  /** 右栏左缘；右栏隐藏时为 null */
  rpL: number | null
  colX: number
  /** 标题栏右侧三个按钮里被遮挡或不在视口内的 */
  hidden: string[]
}

let noteId = ''

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
  const path = '三栏/展开收起.md'
  const tree = await (await c.request.get('/api/tree')).json()
  const existing = tree.notes.find((n: { path: string }) => n.path === path)
  if (existing) noteId = existing.id
  else {
    const para =
      '侧栏展开和收起时，编辑区的正文应该平滑移动，不能在动画开始或结束时突然跳一下。The quick brown fox jumps over the lazy dog while the sidebar slides.'
    const res = await c.request.post('/api/notes', {
      data: { path, content: `# 展开收起\n\n${para}\n\n${para}${para}\n\n- 列表：${para}\n` },
    })
    expect(res.ok()).toBe(true)
    noteId = (await res.json()).id
  }
  await c.close()
})

async function openNote(browser: Browser, layout: Layout, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: VIEWPORT, ...opts })
  await signIn(c)
  await c.addInitScript((l) => {
    if (!sessionStorage.getItem('split-view-layout')) {
      localStorage.setItem('lode.layout', JSON.stringify({ ...l, sidebarWidth: 264, rightTab: 'backlinks' }))
      sessionStorage.setItem('split-view-layout', '1')
    }
  }, layout)
  const p = await c.newPage()
  await p.goto(`/note/${noteId}`)
  await expect(p.locator('.cm-content')).toContainText('平滑移动')
  await expect(p.locator('.editor-bar').getByRole('button', { name: '更多操作' })).toBeVisible()
  await p.waitForTimeout(300)
  return { c, p }
}

/** 开始逐帧采样（requestAnimationFrame），持续 ms 毫秒；用 collect 取回。 */
async function startSampling(p: Page, ms = 900) {
  await p.evaluate((dur) => {
    const w = window as unknown as { __frames: Frame[]; __sampling: Promise<void> }
    w.__frames = []
    const shown = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)
      return el && getComputedStyle(el).visibility !== 'hidden' ? el.getBoundingClientRect() : null
    }
    const labels = ['助手', '右栏', '更多操作']
    const end = performance.now() + dur
    w.__sampling = new Promise((done) => {
      const tick = () => {
        const main = document.querySelector('.shell-main')!.getBoundingClientRect()
        const sb = shown('[data-testid="shell-sidebar"]')
        const rp = shown('.shell-right')
        const col = document.querySelector('.cm-content')!.getBoundingClientRect()
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('.editor-bar button'))
        const hidden: string[] = []
        for (const label of labels) {
          const b = buttons.find((el) => (el.getAttribute('aria-label') ?? '').endsWith(label))
          const r = b?.getBoundingClientRect()
          const inView = r && r.width > 0 && r.left >= -0.5 && r.right <= innerWidth + 0.5
          const top = inView ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
          if (!b || !top || !b.contains(top)) hidden.push(label)
        }
        w.__frames.push({ mainL: main.left, mainR: main.right, sbR: sb?.right ?? null, rpL: rp?.left ?? null, colX: col.left, hidden })
        if (performance.now() < end) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
  }, ms)
}

async function collect(p: Page): Promise<Frame[]> {
  return p.evaluate(async () => {
    const w = window as unknown as { __frames: Frame[]; __sampling: Promise<void> }
    await w.__sampling
    return w.__frames
  })
}

/** 主区域每一帧都贴着侧栏右缘和右栏左缘；标题栏右侧三个按钮每一帧都可见。 */
function edgeProblems(frames: Frame[]): string[] {
  const out: string[] = []
  frames.forEach((f, i) => {
    const left = f.sbR ?? 0
    const right = f.rpL ?? VIEWPORT.width
    if (Math.abs(f.mainL - left) > 1) out.push(`#${i} 主区域左缘 ${f.mainL.toFixed(1)} ≠ 侧栏右缘 ${left.toFixed(1)}`)
    if (Math.abs(f.mainR - right) > 1) out.push(`#${i} 主区域右缘 ${f.mainR.toFixed(1)} ≠ 右栏左缘 ${right.toFixed(1)}`)
    if (f.hidden.length) out.push(`#${i} 看不见：${f.hidden.join('、')}`)
  })
  return out
}

/** 正文列的横向位置：单调地从起点走到终点，有中间帧，没有一帧走完一半以上路程的跳变。 */
function expectSmoothPath(xs: number[], from: number, to: number) {
  const dist = Math.abs(to - from)
  const dir = Math.sign(to - from)
  expect(dist, '正文列确实移动了').toBeGreaterThan(20)
  expect(Math.abs(xs[0] - from), '起点').toBeLessThan(1)
  expect(Math.abs(xs[xs.length - 1] - to), '终点').toBeLessThan(1)
  const steps = xs.slice(1).map((x, i) => x - xs[i])
  expect(steps.filter((s) => s * dir < -0.5), '没有往回走').toEqual([])
  expect(Math.max(...steps.map(Math.abs)), `最大单帧位移（总路程 ${dist.toFixed(0)}）`).toBeLessThan(dist * 0.5)
  const between = new Set(xs.filter((x) => Math.abs(x - from) > 1 && Math.abs(x - to) > 1).map((x) => x.toFixed(1)))
  expect(between.size, '有中间帧').toBeGreaterThan(3)
}

const editorButton = (p: Page, name: string) => p.locator('.editor-bar').getByRole('button', { name, exact: true })

for (const dir of ['展开', '收起'] as const) {
  test(`${dir}右栏：主区域贴着右栏边缘移动，三个按钮每一帧都可见，正文不跳变`, async ({ browser }) => {
    const opening = dir === '展开'
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: !opening })
    const from = await p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().left)
    await startSampling(p)
    await editorButton(p, opening ? '显示右栏' : '隐藏右栏').click()
    const frames = await collect(p)
    expect(edgeProblems(frames)).toEqual([])
    const last = frames[frames.length - 1]
    expect(last.rpL === null).toBe(!opening)
    expectSmoothPath(
      frames.map((f) => f.colX),
      from,
      last.colX,
    )
    await c.close()
  })

  test(`${dir}侧栏：主区域贴着侧栏边缘移动，三个按钮每一帧都可见，正文不跳变`, async ({ browser }) => {
    const opening = dir === '展开'
    const { c, p } = await openNote(browser, { sidebarOpen: !opening, rightOpen: false })
    const from = await p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().left)
    await startSampling(p)
    if (opening) await editorButton(p, '显示侧栏 (Ctrl+\\)').click()
    else await p.getByTestId('shell-sidebar').getByRole('button', { name: '隐藏侧栏 (Ctrl+\\)' }).click()
    const frames = await collect(p)
    expect(edgeProblems(frames)).toEqual([])
    const last = frames[frames.length - 1]
    expect(last.sbR === null).toBe(!opening)
    expectSmoothPath(
      frames.map((f) => f.colX),
      from,
      last.colX,
    )
    await c.close()
  })
}

test('右栏展开途中反向：从当前位置掉头收回，没有跳变，按钮一直可见', async ({ browser }) => {
  const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false })
  const from = await p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().left)
  await startSampling(p, 1000)
  await editorButton(p, '显示右栏').click()
  await p.waitForTimeout(150)
  await editorButton(p, '隐藏右栏').dispatchEvent('click')
  const frames = await collect(p)
  expect(edgeProblems(frames)).toEqual([])
  const xs = frames.map((f) => f.colX)
  const turn = xs.indexOf(Math.min(...xs))
  expect(from - xs[turn], '掉头前确实走了一段').toBeGreaterThan(10)
  expectSmoothPath(xs.slice(0, turn + 1), from, xs[turn])
  expectSmoothPath(xs.slice(turn), xs[turn], from)
  expect(frames[frames.length - 1].rpL).toBeNull()
  await c.close()
})

test('侧栏收起途中按 Ctrl+\\ 反向：从当前位置掉头展开，没有跳变', async ({ browser }) => {
  const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false })
  await p.locator('.editor-crumb').click() // 焦点离开编辑器，快捷键走全局处理
  const from = await p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().left)
  await startSampling(p, 1000)
  await p.keyboard.press('Control+Backslash')
  await p.waitForTimeout(150)
  await p.keyboard.press('Control+Backslash')
  const frames = await collect(p)
  expect(edgeProblems(frames)).toEqual([])
  const xs = frames.map((f) => f.colX)
  const turn = xs.indexOf(Math.min(...xs))
  expect(from - xs[turn], '掉头前确实走了一段').toBeGreaterThan(10)
  expectSmoothPath(xs.slice(0, turn + 1), from, xs[turn])
  expectSmoothPath(xs.slice(turn), xs[turn], from)
  await c.close()
})

test('拖动调整侧栏宽度：主区域每一帧都跟着侧栏边缘，越界松手回弹也不跳', async ({ browser }) => {
  const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: true })
  const handle = (await p.getByTestId('sidebar-resizer').boundingBox())!
  const y = handle.y + 300
  const x0 = handle.x + handle.width / 2
  await startSampling(p, 1500)
  await p.mouse.move(x0, y)
  await p.mouse.down()
  await p.mouse.move(x0 + 120, y, { steps: 12 })
  await p.mouse.move(x0 + 320, y, { steps: 12 }) // 超过最大宽度 420，有阻力
  await p.mouse.up()
  const frames = await collect(p)
  expect(edgeProblems(frames)).toEqual([])
  const widths = frames.map((f) => f.sbR!)
  const peak = Math.max(...widths)
  expect(peak, '拖过了最大宽度').toBeGreaterThan(425)
  // 松手后从越界处回弹到 420：单调减小，没有一帧走完一半以上
  const back = widths.slice(widths.indexOf(peak))
  expectSmoothPath(back, peak, 420)
  await c.close()
})

for (const what of ['右栏', '侧栏'] as const) {
  test(`减弱动态效果时${what}直接切换：没有中间帧，切换后布局正确，按钮一直可见`, async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false }, { reducedMotion: 'reduce' })
    await startSampling(p, 600)
    if (what === '右栏') await editorButton(p, '显示右栏').click()
    else await p.getByTestId('shell-sidebar').getByRole('button', { name: '隐藏侧栏 (Ctrl+\\)' }).click()
    const frames = await collect(p)
    expect(edgeProblems(frames)).toEqual([])
    const widths = new Set(frames.map((f) => (f.mainR - f.mainL).toFixed(1)))
    expect([...widths].length, `主区域宽度只有起点和终点：${[...widths].join(', ')}`).toBeLessThanOrEqual(2)
    const last = frames[frames.length - 1]
    if (what === '右栏') expect(last.rpL).toBeCloseTo(VIEWPORT.width - 300, 0)
    else expect(last.sbR).toBeNull()
    await c.close()
  })
}

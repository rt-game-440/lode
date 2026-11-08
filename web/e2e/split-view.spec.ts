import { type Browser, type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test'

// 桌面三栏的侧栏 / 右栏展开收起（#18）：每一帧采样主区域、两侧面板边缘、正文列和标题栏右侧三个按钮，
// 检查主区域贴着面板边缘移动、按钮始终可见、正文没有单帧跳变，以及拖拽调宽和减弱动态效果。
// 侧栏 / 右栏的收起按钮（#19）：放在面板靠编辑区的一边、左右对称，展开收起时沿面板边缘移动并停在编辑区标题栏的角上。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）。
const PASSWORD = 'e2e-test-password'
const VIEWPORT = { width: 1280, height: 800 }

interface Layout {
  sidebarOpen: boolean
  rightOpen: boolean
}

/** 侧栏 / 右栏收起按钮的一帧 */
interface Toggle {
  l: number
  r: number
  /** 垂直中心 */
  cy: number
  /** 中心点没有被别的元素挡住，且在窗口内 */
  ok: boolean
  /** 自身和所有祖先的不透明度之积 */
  op: number
}

interface Frame {
  mainL: number
  mainR: number
  /** 侧栏右缘；侧栏隐藏时为 null */
  sbR: number | null
  /** 右栏左缘；右栏隐藏时为 null */
  rpL: number | null
  colX: number
  /** 标题栏右侧三个按钮（助手、右栏、更多操作）里被遮挡或不在视口内的 */
  hidden: string[]
  /** 左侧栏收起 / 展开按钮 */
  lt: Toggle | null
  /** 右栏收起 / 展开按钮 */
  rt: Toggle | null
  /** 编辑区标题栏：路径的左缘、“更多操作”的右缘、垂直中心 */
  crumbL: number
  moreR: number
  barCy: number
}

/** 收起按钮离面板边缘、离窗口边缘的距离（--space-2），以及面板分隔线宽度 */
const INSET = 8
const SEP = 1

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
    const visible = (b: HTMLElement | undefined) => {
      const r = b?.getBoundingClientRect()
      const inView = r && r.width > 0 && r.left >= -0.5 && r.right <= innerWidth + 0.5
      const top = inView ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
      return !!(b && top && b.contains(top))
    }
    // 收起按钮浮在三栏之上（不在编辑区标题栏里），按可访问名称找
    const toggle = (re: RegExp) => {
      const b = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]')).find((el) => re.test(el.getAttribute('aria-label')!))
      if (!b) return null
      const r = b.getBoundingClientRect()
      let op = 1
      for (let el: HTMLElement | null = b; el; el = el.parentElement) op *= parseFloat(getComputedStyle(el).opacity)
      return { l: r.left, r: r.right, cy: r.top + r.height / 2, ok: visible(b), op }
    }
    const end = performance.now() + dur
    w.__sampling = new Promise((done) => {
      const tick = () => {
        const main = document.querySelector('.shell-main')!.getBoundingClientRect()
        const sb = shown('[data-testid="shell-sidebar"]')
        const rp = shown('.shell-right')
        const col = document.querySelector('.cm-content')!.getBoundingClientRect()
        const bar = document.querySelector('.editor-bar')!.getBoundingClientRect()
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('.editor-bar button'))
        const byLabel = (label: string) => buttons.find((el) => el.getAttribute('aria-label') === label)
        const hidden = ['助手', '更多操作'].filter((label) => !visible(byLabel(label)))
        const lt = toggle(/^(隐藏|显示)侧栏 \(Ctrl\+\\\)$/)
        const rt = toggle(/^(隐藏|显示)右栏$/)
        if (!rt?.ok) hidden.splice(1, 0, '右栏')
        w.__frames.push({
          mainL: main.left,
          mainR: main.right,
          sbR: sb?.right ?? null,
          rpL: rp?.left ?? null,
          colX: col.left,
          hidden,
          lt,
          rt,
          crumbL: document.querySelector('.editor-crumb')!.getBoundingClientRect().left,
          moreR: byLabel('更多操作')!.getBoundingClientRect().right,
          barCy: bar.top + bar.height / 2,
        })
        if (performance.now() < end) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
  }, ms)
  // 等采样真正跑起来（至少两帧静止画面）再返回：机器负载高时第一帧可能比后面的键盘 / 点击还晚，
  // 动画就会在第一帧之前开始，起点帧已经在半路上
  await p.waitForFunction(() => (window as unknown as { __frames: unknown[] }).__frames.length >= 2)
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

// 侧栏、右栏的收起按钮浮在三栏之上，随面板边缘移动（#19），不属于某个标题栏，按名称找
const button = (p: Page, name: string) => p.getByRole('button', { name, exact: true })

for (const dir of ['展开', '收起'] as const) {
  test(`${dir}右栏：主区域贴着右栏边缘移动，三个按钮每一帧都可见，正文不跳变`, async ({ browser }) => {
    const opening = dir === '展开'
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: !opening })
    const from = await p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().left)
    await startSampling(p)
    await button(p, opening ? '显示右栏' : '隐藏右栏').click()
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
    await button(p, opening ? '显示侧栏 (Ctrl+\\)' : '隐藏侧栏 (Ctrl+\\)').click()
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
  await button(p, '显示右栏').click()
  await p.waitForTimeout(150)
  await button(p, '隐藏右栏').dispatchEvent('click')
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
    if (what === '右栏') await button(p, '显示右栏').click()
    else await button(p, '隐藏侧栏 (Ctrl+\\)').click()
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

/* ---------------- 收起按钮（#19） ---------------- */

const toggleLabel = (side: 'left' | 'right', open: boolean) =>
  side === 'left' ? `${open ? '隐藏' : '显示'}侧栏 (Ctrl+\\)` : `${open ? '隐藏' : '显示'}右栏`
const sideName = (side: 'left' | 'right') => (side === 'left' ? '侧栏' : '右栏')
const toggleOf = (f: Frame, side: 'left' | 'right') => (side === 'left' ? f.lt : f.rt)!
/** 按钮离同侧窗口边缘的距离：左按钮量左缘，右按钮量右缘 */
const nearEdge = (f: Frame, side: 'left' | 'right') => (side === 'left' ? f.lt!.l : VIEWPORT.width - f.rt!.r)
/** 面板展开时按钮离同侧窗口边缘的距离：面板宽度 − 分隔线 − 内边距 − 按钮宽度（32） */
const inPanel = (side: 'left' | 'right') => (side === 'left' ? 264 : 300) - SEP - INSET - 32

/**
 * 收起按钮的逐帧问题：被遮挡、半透明、没和标题栏垂直对齐、压住编辑区标题栏的内容；
 * 面板露出较多时按钮要贴着面板靠编辑区的那条边，面板几乎收起时要停在编辑区标题栏同侧的角上。
 */
function toggleProblems(frames: Frame[], side: 'left' | 'right'): string[] {
  const out: string[] = []
  frames.forEach((f, i) => {
    const b = side === 'left' ? f.lt : f.rt
    if (!b) {
      out.push(`#${i} 没有收起按钮`)
      return
    }
    if (!b.ok) out.push(`#${i} 收起按钮被遮挡或不在窗口内`)
    if (b.op < 0.99) out.push(`#${i} 收起按钮不透明度 ${b.op.toFixed(2)}`)
    if (Math.abs(b.cy - f.barCy) > 1) out.push(`#${i} 收起按钮中心 y=${b.cy.toFixed(1)}，标题栏中心 y=${f.barCy.toFixed(1)}`)
    // 面板露出的宽度（面板靠编辑区那条边到窗口边缘的距离）
    const exposed = side === 'left' ? (f.sbR ?? 0) : f.rpL === null ? 0 : VIEWPORT.width - f.rpL
    const near = side === 'left' ? b.l : VIEWPORT.width - b.r
    const far = side === 'left' ? b.r : VIEWPORT.width - b.l
    // 中间一段（露出约 20–80px）是按钮从贴边转到停在角上的过渡
    if (exposed >= 85 && Math.abs(far - (exposed - SEP - INSET)) > 1)
      out.push(`#${i} 面板露出 ${exposed.toFixed(1)}，按钮没有贴着面板边缘（外缘离窗口边缘 ${far.toFixed(1)}）`)
    if (exposed <= 15 && Math.abs(near - INSET) > 1)
      out.push(`#${i} 面板露出 ${exposed.toFixed(1)}，按钮不在角上（离窗口边缘 ${near.toFixed(1)}）`)
    if (side === 'left' && f.crumbL < b.r + 2) out.push(`#${i} 路径左缘 ${f.crumbL.toFixed(1)} 压在按钮（右缘 ${b.r.toFixed(1)}）下`)
    if (side === 'right' && f.moreR > b.l - 2) out.push(`#${i} “更多操作”右缘 ${f.moreR.toFixed(1)} 压在按钮（左缘 ${b.l.toFixed(1)}）下`)
  })
  return out
}

/** 最大的单帧位移变化（二阶差分的绝对值），衡量运动有多“急” */
function maxAccel(xs: number[]): number {
  return Math.max(0, ...xs.slice(2).map((x, i) => Math.abs(x - 2 * xs[i + 1] + xs[i])))
}

async function rect(l: Locator) {
  return l.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { l: r.left, r: r.right, cy: r.top + r.height / 2 }
  })
}

test.describe('收起按钮（#19）', () => {
  test('两侧收起按钮分别在侧栏标题行最右、右栏标签行最左，位置对称，键盘可达', async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: true })
    const left = await rect(button(p, '隐藏侧栏 (Ctrl+\\)'))
    const right = await rect(button(p, '隐藏右栏'))
    const sb = await rect(p.getByTestId('shell-sidebar'))
    const rp = await rect(p.locator('.shell-right'))
    const newFolder = await rect(button(p, '新建文件夹'))
    const newNote = await rect(p.getByTestId('new-note'))
    const firstTab = await rect(p.getByRole('tab', { name: '反链' }))
    const head = await rect(p.locator('.sidebar-head'))
    const rightHead = await rect(p.locator('.right-head'))
    // 左：侧栏标题行最右，新建文件夹、新建笔记的右侧，紧贴侧栏右缘
    expect(newFolder.r).toBeLessThan(newNote.l)
    expect(left.l - newNote.r, '紧跟在新建笔记右侧').toBeGreaterThan(0)
    expect(left.l - newNote.r, '紧跟在新建笔记右侧').toBeLessThan(8)
    expect(sb.r - left.r, '紧贴侧栏右缘').toBeCloseTo(SEP + INSET, 0)
    // 右：右栏标签行最左，第一个标签的左侧，紧贴右栏左缘
    expect(firstTab.l - right.r, '紧挨第一个标签').toBeGreaterThan(0)
    expect(firstTab.l - right.r, '紧挨第一个标签').toBeLessThan(8)
    expect(right.l - rp.l, '紧贴右栏左缘').toBeCloseTo(SEP + INSET, 0)
    // 对称：离各自面板靠编辑区那条边的距离相同，都在标题行里垂直居中
    expect(Math.abs(sb.r - left.r - (right.l - rp.l))).toBeLessThan(0.5)
    expect(left.cy).toBeCloseTo(head.cy, 0)
    expect(right.cy).toBeCloseTo(rightHead.cy, 0)
    expect(left.cy).toBeCloseTo(right.cy, 0)

    // 键盘：Tab 顺序里，右栏按钮紧挨在右栏标签之前，侧栏按钮紧挨在编辑区标题栏之前
    await p.getByRole('tab', { name: '反链' }).focus()
    await p.keyboard.press('Shift+Tab')
    await expect(button(p, '隐藏右栏')).toBeFocused()
    await p.locator('.editor-bar').getByRole('button', { name: '助手', exact: true }).focus()
    await p.keyboard.press('Shift+Tab')
    await expect(button(p, '隐藏侧栏 (Ctrl+\\)')).toBeFocused()
    // Enter 收起；按钮移到编辑区左上角，焦点留在它上面，再按 Enter 展开
    await p.keyboard.press('Enter')
    await expect(button(p, '显示侧栏 (Ctrl+\\)')).toBeFocused()
    await p.waitForTimeout(700)
    expect((await rect(button(p, '显示侧栏 (Ctrl+\\)'))).l).toBeCloseTo(INSET, 0)
    await p.keyboard.press('Enter')
    await expect(button(p, '隐藏侧栏 (Ctrl+\\)')).toBeFocused()
    await c.close()
  })

  for (const side of ['left', 'right'] as const) {
    for (const dir of ['收起', '展开'] as const) {
      const closing = dir === '收起'
      test(`${dir}${sideName(side)}：收起按钮每一帧都可见，沿${sideName(side)}边缘连续移动，停在${closing ? '编辑区标题栏角上' : '标题行里'}`, async ({
        browser,
      }) => {
        const layout = side === 'left' ? { sidebarOpen: closing, rightOpen: false } : { sidebarOpen: true, rightOpen: closing }
        const { c, p } = await openNote(browser, layout)
        await startSampling(p)
        await button(p, toggleLabel(side, closing)).click()
        const frames = await collect(p)
        expect(toggleProblems(frames, side)).toEqual([])
        expect(edgeProblems(frames)).toEqual([])
        const xs = frames.map((f) => nearEdge(f, side))
        expectSmoothPath(xs, closing ? inPanel(side) : INSET, closing ? INSET : inPanel(side))
        // 停到角上、从角上被带走时没有急刹或猛拽：按钮的单帧位移变化不比面板边缘自己的大太多
        const exposed = frames.map((f) => (side === 'left' ? (f.sbR ?? 0) : f.rpL === null ? 0 : VIEWPORT.width - f.rpL))
        expect(maxAccel(xs), `按钮最大位移变化（面板边缘 ${maxAccel(exposed).toFixed(1)}）`).toBeLessThanOrEqual(maxAccel(exposed) * 1.5 + 0.5)
        // 收起后的展开按钮在编辑区标题栏同侧的角上（toggleProblems 已检查垂直居中）
        await expect(button(p, toggleLabel(side, !closing))).toBeVisible()
        await c.close()
      })
    }
  }

  test('侧栏收起途中按 Ctrl+\\ 反向：收起按钮从当前位置掉头回到标题行，路径连续', async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false })
    await p.locator('.editor-crumb').click() // 焦点离开编辑器，快捷键走全局处理
    await startSampling(p, 1000)
    await p.keyboard.press('Control+Backslash')
    await p.waitForTimeout(200)
    await p.keyboard.press('Control+Backslash')
    const frames = await collect(p)
    expect(toggleProblems(frames, 'left')).toEqual([])
    const xs = frames.map((f) => nearEdge(f, 'left'))
    const turn = xs.indexOf(Math.min(...xs))
    expect(inPanel('left') - xs[turn], '掉头前确实走了一段').toBeGreaterThan(20)
    expectSmoothPath(xs.slice(0, turn + 1), inPanel('left'), xs[turn])
    expectSmoothPath(xs.slice(turn), xs[turn], inPanel('left'))
    await c.close()
  })

  test('右栏展开途中再点一次：收起按钮从当前位置掉头回到角上，路径连续', async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false })
    await startSampling(p, 1000)
    await button(p, '显示右栏').click()
    await p.waitForTimeout(150)
    await button(p, '隐藏右栏').dispatchEvent('click')
    const frames = await collect(p)
    expect(toggleProblems(frames, 'right')).toEqual([])
    const xs = frames.map((f) => nearEdge(f, 'right'))
    const turn = xs.indexOf(Math.max(...xs))
    expect(xs[turn] - INSET, '掉头前确实走了一段').toBeGreaterThan(20)
    expectSmoothPath(xs.slice(0, turn + 1), INSET, xs[turn])
    expectSmoothPath(xs.slice(turn), xs[turn], INSET)
    await c.close()
  })

  for (const side of ['left', 'right'] as const) {
    test(`减弱动态效果时${sideName(side)}收起按钮原地淡出、在角上淡入，没有滑动`, async ({ browser }) => {
      const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: true }, { reducedMotion: 'reduce' })
      await startSampling(p, 800)
      await button(p, toggleLabel(side, true)).click()
      const frames = await collect(p)
      const ops = frames.map((f) => toggleOf(f, side).op)
      const xs = frames.map((f) => nearEdge(f, side))
      expect([...new Set(xs.map((x) => x.toFixed(0)))], '只有起点和终点两个位置').toEqual([inPanel(side).toFixed(0), INSET.toFixed(0)])
      const jump = xs.findIndex((x, i) => i > 0 && Math.abs(x - xs[i - 1]) > 1)
      expect(Math.max(ops[jump - 1], ops[jump]), `换位发生在几乎透明时（第 ${jump} 帧）`).toBeLessThan(0.25)
      expect(ops.slice(0, jump).some((o) => o > 0.25 && o < 0.9), '原地淡出有中间帧').toBe(true)
      expect(ops.slice(jump).some((o) => o > 0.25 && o < 0.9), '在角上淡入有中间帧').toBe(true)
      expect(ops[ops.length - 1]).toBeCloseTo(1, 2)
      expect(frames.every((f) => toggleOf(f, side).ok), '每一帧都没有被遮挡').toBe(true)
      await c.close()
    })
  }

  test('Ctrl+\\ 照常切换侧栏：收起后展开按钮在编辑区标题栏左上角，展开后回到侧栏标题行最右', async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: true, rightOpen: false })
    await p.locator('.editor-crumb').click() // 焦点离开编辑器，快捷键走全局处理
    await p.keyboard.press('Control+Backslash')
    await expect(p.getByTestId('shell-sidebar')).toBeHidden()
    const bar = await rect(p.locator('.editor-bar'))
    const shown = await rect(button(p, '显示侧栏 (Ctrl+\\)'))
    expect(shown.l).toBeCloseTo(INSET, 0)
    expect(shown.cy).toBeCloseTo(bar.cy, 0)
    expect((await rect(p.locator('.editor-crumb'))).l).toBeGreaterThan(shown.r)
    await p.keyboard.press('Control+Backslash')
    await expect(p.getByTestId('shell-sidebar')).toBeVisible()
    await p.waitForTimeout(700)
    const sb = await rect(p.getByTestId('shell-sidebar'))
    expect(sb.r - (await rect(button(p, '隐藏侧栏 (Ctrl+\\)'))).r).toBeCloseTo(SEP + INSET, 0)
    await c.close()
  })

  test('设置子页面：侧栏收起时只有一个展开按钮，停在顶栏左上角，返回按钮让在它右侧；展开后返回按钮回到原位', async ({ browser }) => {
    const { c, p } = await openNote(browser, { sidebarOpen: false, rightOpen: false })
    await p.goto('/settings/keyboard')
    const bar = p.locator('.settings-bar').filter({ hasText: '键盘' })
    const back = bar.getByRole('button', { name: /^返回/ })
    await expect(back).toBeVisible()
    await p.waitForTimeout(400) // 等页面推入动画结束
    await expect(p.getByRole('button', { name: '显示侧栏 (Ctrl+\\)' })).toHaveCount(1)
    const shown = await rect(button(p, '显示侧栏 (Ctrl+\\)'))
    expect(shown.l).toBeCloseTo(INSET, 0)
    expect(shown.cy).toBeCloseTo((await rect(bar)).cy, 0)
    const b = await rect(back)
    expect(b.l, '返回按钮在展开按钮右侧，不重叠').toBeGreaterThanOrEqual(shown.r + 2)
    expect(b.l - shown.r, '和展开按钮之间是一个正常间距').toBeLessThan(12)
    await button(p, '显示侧栏 (Ctrl+\\)').click()
    await expect(p.getByTestId('shell-sidebar')).toBeVisible()
    await p.waitForTimeout(700)
    const sb = await rect(p.getByTestId('shell-sidebar'))
    expect((await rect(back)).l - sb.r, '展开后返回按钮离主区域左缘一个内边距').toBeCloseTo(INSET, 0)
    await c.close()
  })
})

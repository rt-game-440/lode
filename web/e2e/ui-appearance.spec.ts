import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test'

// 笔记外观（#47）：按笔记的页宽、字体写进 front matter 的 lode 键；右侧目录条；整体字号。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）、visual.spec 之前。
const PASSWORD = 'e2e-test-password'
const DESKTOP = { width: 1280, height: 800 }
const MOBILE = { width: 375, height: 812 }

const BODY = [
  '# 第一章',
  '',
  '正文段落，用来观察页宽和字体的变化。The quick brown fox jumps over the lazy dog. 这一段写得长一些，让它在窄页宽下换行。',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  '行内 `code` 也是等宽。',
  '',
].join('\n')

async function signIn(c: BrowserContext | APIRequestContext) {
  const req = 'request' in c ? c.request : c
  const status = await (await req.get('/api/auth/status')).json()
  if (!status.initialized) expect((await req.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  else if (!status.authenticated) expect((await req.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
}

async function createNote(browser: Browser, path: string, content: string): Promise<string> {
  const c = await browser.newContext()
  await signIn(c)
  const res = await c.request.post('/api/notes', { data: { path, content, auto_rename: true } })
  expect(res.ok()).toBe(true)
  const id = (await res.json()).id as string
  await c.close()
  return id
}

async function readNote(c: BrowserContext, id: string): Promise<string> {
  return (await (await c.request.get(`/api/notes/${id}`)).json()).content
}

async function openNote(browser: Browser, id: string, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: DESKTOP, ...opts })
  await signIn(c)
  // 收起两侧栏：编辑区占满窗口，三档页宽都能完整展开
  await c.addInitScript(() => {
    if (!sessionStorage.getItem('appearance-layout')) {
      localStorage.setItem('lode.layout', JSON.stringify({ sidebarOpen: false, rightOpen: false, sidebarWidth: 264, rightTab: 'backlinks' }))
      sessionStorage.setItem('appearance-layout', '1')
    }
  })
  const p = await c.newPage()
  await p.goto(`/note/${id}`)
  await expect(p.locator('.cm-content')).toBeVisible()
  return { c, p }
}

async function openPanel(p: Page) {
  await p.locator('.editor-bar').getByRole('button', { name: '更多操作' }).click()
  await p.getByRole('menuitem', { name: '外观和布局' }).click()
  const panel = p.getByRole('dialog', { name: '外观和布局' })
  await expect(panel).toBeVisible()
  return panel
}

const contentWidth = (p: Page) => p.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().width)

/** 逐帧（requestAnimationFrame）记录正文列宽度，持续 ms 毫秒；用 collectWidths 取回。 */
async function sampleWidths(p: Page, ms = 700) {
  await p.evaluate((dur) => {
    const w = window as unknown as { __widths: number[]; __sampling: Promise<void> }
    w.__widths = []
    const end = performance.now() + dur
    w.__sampling = new Promise((done) => {
      const tick = () => {
        w.__widths.push(document.querySelector('.cm-content')!.getBoundingClientRect().width)
        if (performance.now() < end) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
  }, ms)
}

async function collectWidths(p: Page): Promise<number[]> {
  return p.evaluate(async () => {
    const w = window as unknown as { __widths: number[]; __sampling: Promise<void> }
    await w.__sampling
    return w.__widths
  })
}

async function saved(p: Page) {
  await expect(p.getByTestId('save-status')).toHaveText('已保存', { timeout: 10_000 })
}

test.describe('单篇笔记页宽', () => {
  let id = ''
  test.beforeAll(async ({ browser }) => {
    id = await createNote(browser, '外观/页宽.md', BODY)
  })

  test('三档页宽写进 front matter，刷新、另一个客户端打开后保持，改回默认后文件复原', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    const standard = await contentWidth(p)
    // 46rem
    expect(Math.round(standard)).toBe(736)

    const panel = await openPanel(p)
    await expect(panel.getByRole('radio', { name: '适中' })).toHaveAttribute('aria-checked', 'true')
    // 焦点进面板第一组（字体）的选中项
    await expect(panel.getByRole('radio', { name: '默认' })).toBeFocused()

    await panel.getByRole('radio', { name: '宽', exact: true }).click()
    await expect(panel.getByRole('radio', { name: '宽', exact: true })).toHaveAttribute('aria-checked', 'true')
    const editorWidth = await p.locator('.cm-editor').evaluate((el) => el.getBoundingClientRect().width)
    // 占满编辑区，两侧各留 --editor-gutter-wide（3rem）
    await expect.poll(async () => Math.round(await contentWidth(p))).toBe(Math.round(editorWidth - 96))
    await saved(p)
    expect(await readNote(c, id)).toBe(`---\nlode:\n  width: wide\n---\n${BODY}`)
    // 藏起来的 front matter 不显示在正文里
    await expect(p.locator('.cm-content')).not.toContainText('lode')

    await panel.getByRole('radio', { name: '窄' }).click()
    await expect.poll(() => contentWidth(p)).toBe(576)
    await saved(p)
    expect(await readNote(c, id)).toBe(`---\nlode:\n  width: narrow\n---\n${BODY}`)

    // 刷新后保持
    await p.reload()
    await expect(p.locator('.cm-content')).toBeVisible()
    expect(await contentWidth(p)).toBe(576)

    // 另一个客户端
    const other = await openNote(browser, id)
    expect(await contentWidth(other.p)).toBe(576)
    await other.c.close()

    // 改回默认：文件复原，不留空的 front matter
    const panel2 = await openPanel(p)
    await panel2.getByRole('radio', { name: '适中' }).click()
    await expect.poll(() => contentWidth(p)).toBe(736)
    await saved(p)
    expect(await readNote(c, id)).toBe(BODY)
    await c.close()
  })

  test('切换页宽逐帧平滑过渡，没有单帧跳变；减弱动态效果时直接切换', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    const panel = await openPanel(p)
    const from = await contentWidth(p)
    await sampleWidths(p)
    await panel.getByRole('radio', { name: '宽', exact: true }).click()
    const frames = await collectWidths(p)
    const to = frames[frames.length - 1]
    expect(to).toBeGreaterThan(from + 200)
    // 单调变宽，中间有多帧过渡，任何一帧的变化都不超过总变化的 40%
    const steps = frames.slice(1).map((w, i) => w - frames[i])
    expect(steps.every((d) => d >= -0.5)).toBe(true)
    expect(frames.filter((w) => w > from + 1 && w < to - 1).length).toBeGreaterThan(4)
    expect(Math.max(...steps)).toBeLessThan((to - from) * 0.4)
    // 中途反向：从当前宽度平滑转回
    await panel.getByRole('radio', { name: '适中' }).click()
    await expect.poll(() => contentWidth(p)).toBe(736)
    await saved(p)
    await c.close()

    const reduced = await openNote(browser, id, { reducedMotion: 'reduce' })
    const panel2 = await openPanel(reduced.p)
    await sampleWidths(reduced.p, 400)
    await panel2.getByRole('radio', { name: '宽', exact: true }).click()
    const rframes = await collectWidths(reduced.p)
    const rto = rframes[rframes.length - 1]
    expect(rframes.filter((w) => w > 737 && w < rto - 1)).toEqual([])
    await panel2.getByRole('radio', { name: '适中' }).click()
    await saved(reduced.p)
    await reduced.c.close()
  })

  test('手机上页宽不生效，面板里也没有页宽选项', async ({ browser }) => {
    const setup = await openNote(browser, id)
    await (await openPanel(setup.p)).getByRole('radio', { name: '宽', exact: true }).click()
    await saved(setup.p)
    await setup.c.close()

    const { c, p } = await openNote(browser, id, { viewport: MOBILE, isMobile: true, hasTouch: true })
    const w = await contentWidth(p)
    expect(w).toBeGreaterThan(MOBILE.width - 40)
    expect(w).toBeLessThanOrEqual(MOBILE.width)
    const panel = await openPanel(p)
    await expect(panel.getByRole('radio', { name: '宽', exact: true })).toHaveCount(0)
    await c.close()

    const reset = await openNote(browser, id)
    await (await openPanel(reset.p)).getByRole('radio', { name: '适中' }).click()
    await saved(reset.p)
    expect(await readNote(reset.c, id)).toBe(BODY)
    await reset.c.close()
  })

  test('保留其余 front matter；重命名、移动后设置保留', async ({ browser }) => {
    const src = `---\ntitle: 读书\ntags:\n  - 读书\n---\n${BODY}`
    const nid = await createNote(browser, '外观/有属性.md', src)
    const { c, p } = await openNote(browser, nid)
    // 用户自己的 front matter 照常显示
    await expect(p.locator('.cm-frontmatter').first()).toBeVisible()
    await (await openPanel(p)).getByRole('radio', { name: '宽', exact: true }).click()
    await saved(p)
    expect(await readNote(c, nid)).toBe(`---\ntitle: 读书\ntags:\n  - 读书\nlode:\n  width: wide\n---\n${BODY}`)
    await expect(p.locator('.cm-content')).toContainText('tags:')
    await expect(p.locator('.cm-content')).not.toContainText('lode')
    expect((await (await c.request.get(`/api/notes/${nid}/tags`)).json()).tags).toEqual(['读书'])

    // 重命名（标题输入框）
    await p.keyboard.press('Escape')
    const title = p.getByRole('textbox', { name: '笔记标题' })
    await title.fill('读书改名')
    await title.press('Enter')
    await expect.poll(async () => (await (await c.request.get(`/api/notes/${nid}`)).json()).path).toBe('外观/读书改名.md')
    // 移动到别的文件夹
    expect((await c.request.post(`/api/notes/${nid}/move`, { data: { path: '外观/子目录/读书改名.md' } })).ok()).toBe(true)
    await c.close()

    const again = await openNote(browser, nid)
    await expect.poll(() => contentWidth(again.p)).toBeGreaterThan(1000)
    expect(await readNote(again.c, nid)).toContain('lode:\n  width: wide')
    await again.c.close()
  })
})

/** 元素计算后的第一个字体族 */
const firstFamily = (p: Page, sel: string) =>
  p.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/['"]/g, ''))

test.describe('单篇笔记字体', () => {
  let id = ''
  test.beforeAll(async ({ browser }) => {
    id = await createNote(browser, '外观/字体.md', BODY)
  })

  test('三种字体写进 front matter，正文和标题换字体，代码块始终等宽', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    expect(await firstFamily(p, '.cm-line')).toBe('-apple-system')
    const panel = await openPanel(p)
    const cards = panel.getByRole('radiogroup', { name: '字体' }).getByRole('radio')
    await expect(cards).toHaveText(['Ag默认', 'Ag衬线', 'Ag等宽'])
    await expect(panel.getByRole('radio', { name: '默认' })).toHaveAttribute('aria-checked', 'true')
    // 预览字样用各自的字体渲染
    expect(await firstFamily(p, '.font-card-sample.font-serif')).toBe('ui-serif')
    expect(await firstFamily(p, '.font-card-sample.font-mono')).toBe('ui-monospace')

    await panel.getByRole('radio', { name: '衬线' }).click()
    await expect(panel.getByRole('radio', { name: '衬线' })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => firstFamily(p, '.cm-line:not(.cm-codeblock)')).toBe('ui-serif')
    expect(await firstFamily(p, '.editor-title')).toBe('ui-serif')
    expect(await firstFamily(p, '.cm-codeblock')).toBe('ui-monospace')
    expect(await firstFamily(p, '.cm-inline-code')).toBe('ui-monospace')
    await saved(p)
    expect(await readNote(c, id)).toBe(`---\nlode:\n  font: serif\n---\n${BODY}`)

    // 方向键在字体之间切换
    await panel.getByRole('radio', { name: '衬线' }).press('ArrowRight')
    await expect(panel.getByRole('radio', { name: '等宽' })).toBeFocused()
    await expect.poll(() => firstFamily(p, '.cm-line:not(.cm-codeblock)')).toBe('ui-monospace')
    await saved(p)
    expect(await readNote(c, id)).toBe(`---\nlode:\n  font: mono\n---\n${BODY}`)

    // 和页宽共存
    await panel.getByRole('radio', { name: '宽', exact: true }).click()
    await saved(p)
    expect(await readNote(c, id)).toBe(`---\nlode:\n  font: mono\n  width: wide\n---\n${BODY}`)

    // 刷新后保持
    await p.reload()
    await expect.poll(() => firstFamily(p, '.cm-line:not(.cm-codeblock)')).toBe('ui-monospace')
    await c.close()
  })

  test('手机上同样生效，改回默认后文件复原', async ({ browser }) => {
    const { c, p } = await openNote(browser, id, { viewport: MOBILE, isMobile: true, hasTouch: true })
    await expect.poll(() => firstFamily(p, '.cm-line:not(.cm-codeblock)')).toBe('ui-monospace')
    const panel = await openPanel(p)
    await panel.getByRole('radio', { name: '衬线' }).click()
    await expect.poll(() => firstFamily(p, '.cm-line:not(.cm-codeblock)')).toBe('ui-serif')
    expect(await firstFamily(p, '.cm-codeblock')).toBe('ui-monospace')
    await panel.getByRole('radio', { name: '默认' }).click()
    await saved(p)
    // 手机上看不到页宽，页宽设置保持不变
    expect(await readNote(c, id)).toBe(`---\nlode:\n  width: wide\n---\n${BODY}`)
    await c.close()

    const d = await openNote(browser, id)
    await (await openPanel(d.p)).getByRole('radio', { name: '适中' }).click()
    await saved(d.p)
    expect(await readNote(d.c, id)).toBe(BODY)
    await d.c.close()
  })
})

// 设置 LODE_SCREENSHOTS=issue-47 时生成人工检查用的截图，输出到 docs/screenshots/issue-47/
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(450)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

const DEMO = [
  '# 读《三国演义》',
  '',
  '滚滚长江东逝水，浪花淘尽英雄。是非成败转头空，青山依旧在，几度夕阳红。The quick brown fox jumps over the lazy dog.',
  '',
  '## 人物',
  '',
  '刘备、关羽、张飞桃园结义，诸葛亮隆中对策，三分天下的格局由此奠定。全书以宏大的篇幅描写了从东汉末年到西晋初年之间近百年的历史风云。',
  '',
  '### 曹操',
  '',
  '宁教我负天下人，休教天下人负我。',
  '',
  '```js',
  "const heroes = ['刘备', '关羽', '张飞']",
  '```',
  '',
  '## 结构',
  '',
  '全书一百二十回，前半部分以群雄逐鹿为主，后半部分以三国鼎立、诸葛亮北伐为主线。',
  '',
].join('\n')

test.describe('截图', () => {
  test.skip(!shotStage, '设置 LODE_SCREENSHOTS 后才生成截图')

  test('页宽三档、字体三种', async ({ browser }) => {
    const id = await createNote(browser, '外观/截图.md', DEMO)
    const { c, p } = await openNote(browser, id)
    const panel = await openPanel(p)
    await shot(p, '01-panel')
    for (const [w, name] of [['窄', 'narrow'], ['适中', 'standard'], ['宽', 'wide']] as const) {
      await panel.getByRole('radio', { name: w, exact: true }).click()
      await shot(p, `02-width-${name}`)
    }
    await panel.getByRole('radio', { name: '适中' }).click()
    for (const [f, name] of [['默认', 'sans'], ['衬线', 'serif'], ['等宽', 'mono']] as const) {
      await panel.getByRole('radio', { name: f }).click()
      await shot(p, `03-font-${name}`)
    }
    await panel.getByRole('radio', { name: '默认' }).click()
    await saved(p)
    await c.close()
  })
})

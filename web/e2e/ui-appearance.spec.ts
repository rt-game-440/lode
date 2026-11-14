import { mkdirSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
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
    await p.getByTestId('note-title').click()
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

/** 一篇有 n 个小节的长笔记：一级标题下面是二级、三级标题 */
function longNote(n: number): string {
  const para = '这一段用来撑开篇幅，让正文足够长，可以滚动。The quick brown fox jumps over the lazy dog. '.repeat(4)
  const out = ['# 总览', '', para, '']
  for (let i = 1; i <= n; i++) out.push(i % 4 === 1 ? `## 第 ${i} 节` : `### 第 ${i} 节`, '', para, '', para, '')
  return out.join('\n')
}

const rail = (p: Page) => p.getByTestId('toc-rail')
const tocCard = (p: Page) => p.getByTestId('toc-card')
const activeBar = (p: Page) => p.locator('.toc-bar').evaluateAll((bars) => bars.findIndex((b) => b.classList.contains('is-active')))
const scrollTop = (p: Page) => p.locator('.editor-scroll').evaluate((el) => el.scrollTop)
/** 标题行顶部离滚动区顶部的距离 */
const headingOffset = (p: Page, text: string) =>
  p.evaluate((t) => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find((l) => l.textContent === t)
    if (!line) return null
    return line.getBoundingClientRect().top - document.querySelector('.editor-scroll')!.getBoundingClientRect().top
  }, text)

test.describe('目录条', () => {
  let id = ''
  let plain = ''
  test.beforeAll(async ({ browser }) => {
    id = await createNote(browser, '外观/目录条.md', longNote(24))
    plain = await createNote(browser, '外观/没有标题.md', '只有正文，没有标题。\n\n第二段。')
  })

  test('细线对应标题，放在正文列外侧；悬停延迟展开、移开收起', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    await expect(rail(p)).toBeVisible()
    await expect(p.locator('.toc-bar')).toHaveCount(25)
    // 层级越深越短：一级 > 二级 > 三级
    const widths = await p.locator('.toc-bar').evaluateAll((bars) => bars.slice(0, 3).map((b) => b.getBoundingClientRect().width))
    expect(widths[0]).toBeGreaterThan(widths[1])
    expect(widths[1]).toBeGreaterThan(widths[2])
    expect(await activeBar(p)).toBe(0)
    // 不遮挡正文：目录条在正文文字区域的右侧
    const overlap = await p.evaluate(() => {
      const content = document.querySelector('.cm-content')!
      const pad = parseFloat(getComputedStyle(content).paddingRight)
      const textRight = content.getBoundingClientRect().right - pad
      return document.querySelector('.toc-bar')!.getBoundingClientRect().left - textRight
    })
    expect(overlap).toBeGreaterThan(0)

    // 悬停：短暂延迟后才展开
    await rail(p).locator('.toc-rail').hover()
    await expect(tocCard(p)).toHaveCount(0)
    await expect(tocCard(p)).toBeVisible()
    await expect(tocCard(p).getByRole('button')).toHaveCount(25)
    await expect(tocCard(p).getByRole('button', { name: '总览' })).toHaveAttribute('aria-current', 'location')
    // 移开后收起
    await p.mouse.move(400, 500)
    await expect(tocCard(p)).toHaveCount(0)
    await c.close()
  })

  test('点击平滑滚动到标题，滚动正文时当前项跟随', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    await rail(p).locator('.toc-rail').hover()
    await expect(tocCard(p)).toBeVisible()
    // 逐帧记录滚动位置：平滑滚动有多帧中间值
    await p.evaluate(() => {
      const w = window as unknown as { __tops: number[] }
      w.__tops = []
      const el = document.querySelector('.editor-scroll')!
      const end = performance.now() + 700
      const tick = () => {
        w.__tops.push(el.scrollTop)
        if (performance.now() < end) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await tocCard(p).getByRole('button', { name: '第 13 节' }).click()
    await expect.poll(async () => Math.abs((await headingOffset(p, '第 13 节')) ?? 999)).toBeLessThan(40)
    const tops = await p.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
    const final = tops[tops.length - 1]
    expect(tops.filter((t) => t > 1 && t < final - 1).length).toBeGreaterThan(3)
    await expect.poll(() => activeBar(p)).toBe(13)
    await expect(tocCard(p).getByRole('button', { name: '第 13 节' })).toHaveAttribute('aria-current', 'location')

    // 移开收起后，手动滚动正文：当前项跟着变
    await p.mouse.move(400, 500)
    await expect(tocCard(p)).toHaveCount(0)
    await p.mouse.wheel(0, -1500)
    await expect.poll(() => activeBar(p)).toBeLessThan(13)
    // 滚到底：编辑器边滚边实测行高，总高度会变，所以每次轮询都再滚到底
    await expect
      .poll(async () => {
        await p.locator('.editor-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
        return activeBar(p)
      })
      .toBe(24)
    await c.close()
  })

  test('键盘可用：聚焦展开，Enter 跳转，Esc 收起并回到目录条', async ({ browser }) => {
    const { c, p } = await openNote(browser, id)
    await rail(p).locator('.toc-rail').focus()
    await expect(tocCard(p)).toBeVisible()
    await p.keyboard.press('Tab')
    await p.keyboard.press('Tab')
    await expect(tocCard(p).getByRole('button', { name: '第 1 节' })).toBeFocused()
    await p.keyboard.press('Enter')
    await expect.poll(async () => Math.abs((await headingOffset(p, '第 1 节')) ?? 999)).toBeLessThan(40)
    await p.keyboard.press('Escape')
    await expect(tocCard(p)).toHaveCount(0)
    await expect(rail(p).locator('.toc-rail')).toBeFocused()
    await c.close()
  })

  test('减弱动态效果：卡片只淡入不缩放，点击直接跳到标题', async ({ browser }) => {
    const { c, p } = await openNote(browser, id, { reducedMotion: 'reduce' })
    await rail(p).locator('.toc-rail').hover()
    await expect(tocCard(p)).toBeVisible()
    expect(await tocCard(p).evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)
    const before = await scrollTop(p)
    await tocCard(p).getByRole('button', { name: '第 20 节' }).click()
    // 下一帧就已经到位，没有中间帧
    const after = await p.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => r(document.querySelector('.editor-scroll')!.scrollTop))))
    expect(after).toBeGreaterThan(before + 500)
    expect(Math.abs((await headingOffset(p, '第 20 节')) ?? 999)).toBeLessThan(40)
    await c.close()
  })

  test('没有标题、手机上不显示；开关在设置和外观面板里，刷新后保持', async ({ browser }) => {
    const none = await openNote(browser, plain)
    await expect(none.p.locator('.cm-content')).toContainText('只有正文')
    await expect(rail(none.p)).toHaveCount(0)
    await none.c.close()

    const mobile = await openNote(browser, id, { viewport: MOBILE, isMobile: true, hasTouch: true })
    await expect(mobile.p.locator('.cm-content')).toContainText('总览')
    await expect(rail(mobile.p)).toHaveCount(0)
    await mobile.c.close()

    const { c, p } = await openNote(browser, id)
    await expect(rail(p)).toBeVisible()
    await p.goto('/settings/editor')
    const sw = p.getByTestId('toc-rail-switch')
    await expect(sw).toBeChecked()
    await sw.uncheck()
    await p.goto(`/note/${id}`)
    await expect(p.locator('.cm-content')).toContainText('总览')
    await expect(rail(p)).toHaveCount(0)
    await p.reload()
    await expect(p.locator('.cm-content')).toContainText('总览')
    await expect(rail(p)).toHaveCount(0)
    // 外观面板里打开
    const panel = await openPanel(p)
    const toggle = panel.getByTestId('appearance-toc-switch')
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await expect(rail(p)).toBeVisible()
    await p.goto('/settings/editor')
    await expect(p.getByTestId('toc-rail-switch')).toBeChecked()
    await c.close()
  })
})

const SIZES = [
  ['小', 'small', 0.875],
  ['标准', 'standard', 1],
  ['大', 'large', 1.125],
  ['特大', 'xlarge', 1.25],
] as const

/** 以像素为单位的计算字号 */
const fontPx = (p: Page, selector: string) => p.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

/** 页面上文字超出自己盒子（被截断或错位）的控件：可见、且文字范围越出元素边界。省略号截断的长标题是有意的，不在检查范围 */
function overflowing(p: Page, selector: string) {
  return p.evaluate((sel) => {
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.offsetParent || el.clientWidth === 0) continue
      if (getComputedStyle(el).textOverflow === 'ellipsis') continue
      // 比较文字本身的范围和元素的盒子（不用 scrollWidth：扩大点按区域的伪元素也会算进去）
      const range = document.createRange()
      range.selectNodeContents(el)
      const t = range.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      if (t.width === 0) continue
      if (t.left < b.left - 1 || t.right > b.right + 1 || t.top < b.top - 1 || t.bottom > b.bottom + 1)
        out.push(`${el.className}: ${el.textContent?.slice(0, 20)}`)
    }
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('页面出现横向滚动')
    return out
  }, selector)
}

const BODY_LINE = '.cm-line:has-text("正文段落")'
const CONTROLS = 'button, [role="radio"], [role="switch"], .segment, .choice-label, .settings-row-label, .settings-group-title, .editor-title'

async function openSettingsAppearance(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const c = await browser.newContext({ locale: 'zh-CN', viewport: DESKTOP, ...opts })
  await signIn(c)
  const p = await c.newPage()
  await p.goto('/settings/appearance')
  await expect(p.getByRole('radiogroup', { name: '字号' })).toBeVisible()
  return { c, p }
}

test.describe('整体字号', () => {
  let id = ''
  test.beforeAll(async ({ browser }) => {
    id = await createNote(browser, '外观/字号.md', BODY)
  })

  test('四档同时缩放界面和正文，没有截断；按设备保存', async ({ browser }) => {
    const { c, p } = await openSettingsAppearance(browser)
    const group = p.getByRole('radiogroup', { name: '字号' })
    await expect(group.getByRole('radio', { name: '标准' })).toHaveAttribute('aria-checked', 'true')
    const base = await fontPx(p, 'html')
    const ui0 = await fontPx(p, '.choice-label')
    const prev0 = await fontPx(p, '.font-size-preview-body')
    for (const [label, , scale] of SIZES) {
      await group.getByRole('radio', { name: label, exact: true }).click()
      // 实时生效：根字号、界面文字、预览正文按同一比例变化
      await expect.poll(() => fontPx(p, 'html')).toBeCloseTo(base * scale, 1)
      expect(await fontPx(p, '.choice-label')).toBeCloseTo(ui0 * scale, 1)
      expect(await fontPx(p, '.font-size-preview-body')).toBeCloseTo(prev0 * scale, 1)
      expect(await overflowing(p, CONTROLS)).toEqual([])
    }
    // 键盘：方向键切换
    await group.getByRole('radio', { name: '特大' }).focus()
    await p.keyboard.press('ArrowLeft')
    await expect(group.getByRole('radio', { name: '大', exact: true })).toBeFocused()
    await expect(group.getByRole('radio', { name: '大', exact: true })).toHaveAttribute('aria-checked', 'true')

    // 刷新后保持；笔记正文、标题、工具栏都按“大”渲染
    await p.goto(`/note/${id}`)
    await expect(p.locator('.cm-content')).toContainText('正文段落')
    expect(await fontPx(p, 'html')).toBeCloseTo(base * 1.125, 1)
    const big = { body: await fontPx(p, BODY_LINE), title: await fontPx(p, '.editor-title') }
    expect(await overflowing(p, CONTROLS)).toEqual([])
    // 代码块仍是等宽
    expect(await firstFamily(p, '.cm-codeblock')).toBe('ui-monospace')

    // 另一台设备（新的浏览器上下文）不受影响，仍是标准
    const other = await openNote(browser, id)
    expect(await fontPx(other.p, 'html')).toBeCloseTo(base, 1)
    const std = { body: await fontPx(other.p, BODY_LINE), title: await fontPx(other.p, '.editor-title') }
    expect(big.body).toBeCloseTo(std.body * 1.125, 1)
    expect(big.title).toBeCloseTo(std.title * 1.125, 1)
    await other.c.close()

    // 改回标准：不留本机记录
    await p.goto('/settings/appearance')
    await p.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '标准' }).click()
    expect(await p.evaluate(() => localStorage.getItem('lode.display.fontSize'))).toBeNull()
    expect(await p.evaluate(() => document.documentElement.hasAttribute('data-font-size'))).toBe(false)
    await c.close()
  })

  test('尊重浏览器的默认字号：各档在它的基础上缩放', async ({ browser }) => {
    const { c, p } = await openSettingsAppearance(browser)
    // 模拟用户把浏览器默认字号调成 20px
    const cdp = await c.newCDPSession(p)
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: 20 } })
    await p.reload()
    await expect.poll(() => fontPx(p, 'html')).toBe(20)
    await p.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '大', exact: true }).click()
    await expect.poll(() => fontPx(p, 'html')).toBe(22.5)
    await c.close()
  })

  test('手机上特大档没有截断', async ({ browser }) => {
    const { c, p } = await openSettingsAppearance(browser, { viewport: MOBILE, isMobile: true, hasTouch: true })
    await p.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '特大' }).click()
    await expect.poll(() => fontPx(p, 'html')).toBeGreaterThan(19)
    expect(await overflowing(p, CONTROLS)).toEqual([])
    await p.goto(`/note/${id}`)
    await expect(p.locator('.cm-content')).toContainText('正文段落')
    expect(await overflowing(p, CONTROLS)).toEqual([])
    await c.close()
  })
})

test.describe('无障碍', () => {
  async function axeBad(p: Page) {
    await p.waitForTimeout(500) // 等入场动画结束，避免半透明中间态影响对比度计算
    const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}（${v.impact}）：${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join('；')}`)
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe ${scheme}：外观面板、目录卡片、字号设置`, async ({ browser }) => {
      const id = await createNote(browser, '外观/无障碍.md', longNote(6))
      const { c, p } = await openNote(browser, id, { colorScheme: scheme })
      await openPanel(p)
      expect(await axeBad(p)).toEqual([])
      await p.keyboard.press('Escape')
      await rail(p).locator('.toc-rail').hover()
      await expect(tocCard(p)).toBeVisible()
      expect(await axeBad(p)).toEqual([])
      await p.goto('/settings/appearance')
      await expect(p.getByRole('radiogroup', { name: '字号' })).toBeVisible()
      expect(await axeBad(p)).toEqual([])
      await c.close()
    })
  }
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

  test('目录条：收起、悬停展开，录下跳转和页宽切换', async ({ browser }) => {
    const id = await createNote(browser, '外观/目录条截图.md', longNote(16))
    const { c, p } = await openNote(browser, id, { recordVideo: { dir: resolve(shotDir, 'video'), size: DESKTOP } })
    await expect(rail(p)).toBeVisible()
    await shot(p, '04-toc-collapsed')
    await rail(p).locator('.toc-rail').hover()
    await expect(tocCard(p)).toBeVisible()
    await shot(p, '05-toc-expanded')
    await tocCard(p).getByRole('button', { name: '第 9 节' }).click()
    await p.waitForTimeout(900)
    await shot(p, '06-toc-jumped')
    await p.mouse.move(400, 500)
    await p.waitForTimeout(600)
    // 页宽切换的过渡也录进去
    const panel = await openPanel(p)
    for (const w of ['宽', '窄', '适中']) {
      await panel.getByRole('radio', { name: w, exact: true }).click()
      await p.waitForTimeout(700)
    }
    await p.keyboard.press('Escape')
    await saved(p)
    const video = p.video()
    await c.close()
    if (video) renameSync(await video.path(), resolve(shotDir, 'video', 'toc-and-width.webm'))
  })

  test('整体字号各档：设置页、笔记页、手机', async ({ browser }) => {
    const id = await createNote(browser, '外观/字号截图.md', DEMO)
    const { c, p } = await openSettingsAppearance(browser)
    const group = p.getByRole('radiogroup', { name: '字号' })
    for (const [label, name] of SIZES) {
      await group.getByRole('radio', { name: label, exact: true }).click()
      await shot(p, `07-size-settings-${name}`)
    }
    // 笔记页（侧栏展开）：小、标准、特大
    for (const [label, name] of [SIZES[0], SIZES[1], SIZES[3]]) {
      await p.goto('/settings/appearance')
      await p.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: label, exact: true }).click()
      await p.goto(`/note/${id}`)
      await expect(p.locator('.cm-content')).toContainText('桃园结义')
      await shot(p, `08-size-note-${name}`)
    }
    await c.close()

    const m = await openSettingsAppearance(browser, { viewport: MOBILE, isMobile: true, hasTouch: true })
    await m.p.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '特大' }).click()
    await shot(m.p, '09-size-mobile-settings-xlarge')
    await m.p.goto(`/note/${id}`)
    await expect(m.p.locator('.cm-content')).toContainText('桃园结义')
    await shot(m.p, '09-size-mobile-note-xlarge')
    await m.c.close()
  })
})

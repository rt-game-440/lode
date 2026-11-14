import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Page, expect, test } from '@playwright/test'

// #75 笔记标题在顶栏左上角：“路径 / 标题”，点击原地改名；浏览模式不可改；窄宽度先截断路径再截断标题。
// 设置 LODE_SCREENSHOTS=issue-75 时另外把三种宽度、长路径和长标题的截断效果截图到 docs/screenshots/issue-75/。
// 文件名排在 ui-settings 之后、ui-workspaces 之前；不新建工作空间。
const PASSWORD = 'e2e-test-password'
const shots = process.env.LODE_SCREENSHOTS === 'issue-75' ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', 'issue-75') : ''
const LONG_DIR = '标题顶栏/一个相当长的文件夹名称/另一个同样很长的子文件夹/第三层目录'
const LONG_TITLE = '这是一个非常非常长的笔记标题用来检查窄屏幕下标题的截断效果是否正常'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  if (shots) mkdirSync(shots, { recursive: true })
})

test.afterAll(async () => {
  await page.close()
})

async function makeNote(path: string, content: string): Promise<string> {
  const r = await page.request.post('/api/notes', { data: { path, content } })
  expect(r.ok()).toBe(true)
  return (await r.json()).id as string
}
const getNote = async (id: string) => (await (await page.request.get(`/api/notes/${id}`)).json()) as { path: string }
const rect = (sel: string) =>
  page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { l: r.left, r: r.right, t: r.top, b: r.bottom }
  })

test('顶栏显示“路径 / 标题”，正文上方没有大标题；点击改名后文件树、磁盘、反链同步，Esc 取消', async () => {
  const target = await makeNote('标题顶栏/甲.md', '甲的正文')
  await makeNote('标题顶栏/引用.md', '指向 [[甲]] 的笔记')
  await page.goto(`/note/${target}`)
  const title = page.getByTestId('note-title')
  await expect(title).toHaveText('甲')
  await expect(title).toHaveAttribute('aria-label', '笔记标题：甲，点击重命名')
  await expect(page.getByTestId('note-path')).toContainText('标题顶栏')
  // 标题在顶栏里，正文区域里没有标题元素
  expect(await page.locator('.editor-bar .editor-title').count()).toBe(1)
  expect(await page.locator('.editor-scroll .editor-title').count()).toBe(0)

  // Esc 取消
  await title.click()
  const input = page.getByRole('textbox', { name: '笔记标题' })
  await expect(input).toBeFocused()
  await input.fill('不该生效')
  await input.press('Escape')
  await expect(title).toHaveText('甲')
  expect((await getNote(target)).path).toBe('标题顶栏/甲.md')

  // 键盘回车进入编辑，改名后焦点回到正文
  await title.focus()
  await page.keyboard.press('Enter')
  await expect(input).toBeFocused()
  await input.fill('乙')
  await input.press('Enter')
  await expect(page.locator('.cm-content')).toBeFocused()
  await expect(title).toHaveText('乙')
  await expect.poll(async () => (await getNote(target)).path).toBe('标题顶栏/乙.md')
  await expect(page.getByRole('treeitem', { name: '乙' })).toBeVisible()
  // 反链：引用笔记里的链接随之改写
  const refs = await (await page.request.get('/api/tree')).json()
  const ref = refs.notes.find((n: { path: string }) => n.path === '标题顶栏/引用.md')
  await expect
    .poll(async () => (await (await page.request.get(`/api/notes/${ref.id}`)).json()).content)
    .toBe('指向 [[乙]] 的笔记')

  // 失焦提交
  await title.click()
  await input.fill('丙')
  await page.locator('.editor-crumb').click()
  await expect(title).toHaveText('丙')
  await expect.poll(async () => (await getNote(target)).path).toBe('标题顶栏/丙.md')
})

test('更多操作 → 重命名聚焦到顶栏标题输入框；新建笔记同样聚焦', async () => {
  const id = await makeNote('标题顶栏/菜单.md', '正文')
  await page.goto(`/note/${id}`)
  await expect(page.getByTestId('note-title')).toHaveText('菜单')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  const input = page.getByRole('textbox', { name: '笔记标题' })
  await expect(input).toBeFocused()
  expect(await input.evaluate((el: HTMLInputElement) => el.closest('.editor-bar') !== null && el.selectionEnd! - el.selectionStart!)).toBe(2)
  await input.press('Escape')

  await page.getByTestId('new-note').click()
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toBeFocused()
  expect(await page.locator('.editor-bar input.editor-title').count()).toBe(1)
})

test('重名时保持原标题', async () => {
  await makeNote('标题顶栏/占用.md', 'x')
  const id = await makeNote('标题顶栏/冲突.md', 'y')
  await page.goto(`/note/${id}`)
  await page.getByTestId('note-title').click()
  const input = page.getByRole('textbox', { name: '笔记标题' })
  await input.fill('占用')
  await input.press('Enter')
  await expect(page.getByTestId('note-title')).toHaveText('冲突')
  expect((await getNote(id)).path).toBe('标题顶栏/冲突.md')
})

test('仅浏览模式下标题不可编辑', async () => {
  const id = await makeNote('标题顶栏/浏览.md', '正文')
  await page.goto(`/note/${id}`)
  const title = page.getByTestId('note-title')
  await page.getByTestId('browse-toggle').click()
  await expect(title).toHaveAttribute('aria-disabled', 'true')
  await expect(title).toHaveAttribute('aria-label', '笔记标题：浏览')
  await title.click({ force: true })
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveCount(0)
  await page.getByRole('button', { name: '更多操作' }).click()
  await expect(page.getByRole('menuitem', { name: '重命名' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('browse-toggle').click()
  await title.click()
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toBeFocused()
})

test('远端改名时顶栏标题实时更新；正在编辑时不被覆盖', async () => {
  const id = await makeNote('标题顶栏/远端.md', '正文')
  await page.goto(`/note/${id}`)
  const title = page.getByTestId('note-title')
  await expect(title).toHaveText('远端')
  const move = (to: string) => page.request.post(`/api/notes/${id}/move`, { data: { path: to } })
  expect((await move('标题顶栏/远端二.md')).ok()).toBe(true)
  await expect(title).toHaveText('远端二')

  await title.click()
  const input = page.getByRole('textbox', { name: '笔记标题' })
  await input.fill('正在输入')
  expect((await move('标题顶栏/远端三.md')).ok()).toBe(true)
  await page.waitForTimeout(800)
  await expect(input).toHaveValue('正在输入')
  await input.press('Escape')
  await expect(title).toHaveText('远端三')
})

for (const width of [375, 768, 1440]) {
  test(`宽度 ${width}：长路径和长标题截断，不与按钮重叠、无横向滚动，axe 通过`, async ({ browser }) => {
    const mobile = width < 768
    const c = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width, height: mobile ? 812 : 900 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    })
    const status = await (await c.request.get('/api/auth/status')).json()
    if (!status.authenticated) await c.request.post('/api/auth/login', { data: { password: PASSWORD } })
    const long = `${LONG_DIR}/${LONG_TITLE}.md`
    let id = ''
    const tree = await (await c.request.get('/api/tree')).json()
    const ex = tree.notes.find((n: { path: string }) => n.path === long)
    if (ex) id = ex.id
    else id = (await (await c.request.post('/api/notes', { data: { path: long, content: '# 长标题\n\n正文。' } })).json()).id
    const p = await c.newPage()
    await p.goto(`/note/${id}`)
    await expect(p.locator('.cm-content')).toContainText('正文')
    await p.waitForTimeout(500)

    const bar = await p.evaluate(() => {
      const h = document.querySelector('.editor-heading')!.getBoundingClientRect()
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('.editor-bar button:not(.editor-title)'))
        .filter((b) => b.checkVisibility())
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.left >= h.left)
      const crumb = document.querySelector<HTMLElement>('.editor-crumb')
      const t = document.querySelector<HTMLElement>('.editor-title')!
      return {
        headR: h.right,
        btnL: Math.min(...buttons.map((r) => r.left)),
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        crumbCut: crumb ? crumb.scrollWidth > crumb.clientWidth : null,
        titleCut: t.scrollWidth > t.clientWidth,
        titleW: t.getBoundingClientRect().width,
        hasPath: !!crumb,
      }
    })
    expect(bar.scrollW).toBeLessThanOrEqual(bar.clientW)
    expect(bar.headR).toBeLessThanOrEqual(bar.btnL + 1)
    expect(bar.hasPath).toBe(!mobile)
    // 路径先被截断，标题尽量完整
    if (width === 768) expect(bar.crumbCut).toBe(true)
    expect(bar.titleW).toBeGreaterThan(80)
    if (mobile) {
      // 手机：返回按钮 + 标题，点标题同样可以改名
      await p.getByTestId('note-title').click()
      await expect(p.getByRole('textbox', { name: '笔记标题' })).toBeFocused()
      await p.keyboard.press('Escape')
    }
    const axe = await new AxeBuilder({ page: p }).analyze()
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    if (shots) await p.screenshot({ path: resolve(shots, `长路径长标题-${width}.png`) })
    // 悬停显示完整路径
    expect(await p.locator('.editor-heading').getAttribute('title')).toContain(LONG_TITLE)
    await c.close()
  })
}

test('桌面侧栏展开收起时标题位置连续、不被展开按钮遮挡', async ({ browser }) => {
  const id = await makeNote('标题顶栏/逐帧.md', '正文')
  const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  await c.request.post('/api/auth/login', { data: { password: PASSWORD } })
  const p = await c.newPage()
  await p.goto(`/note/${id}`)
  await expect(p.getByTestId('note-title')).toHaveText('逐帧')
  await p.locator('.editor-crumb').click()
  await p.waitForTimeout(400)
  const sample = async (action: () => Promise<void>) => {
    await p.evaluate(() => {
      const w = window as unknown as { __x: number[]; __run: boolean }
      w.__x = []
      w.__run = true
      const tick = () => {
        w.__x.push(document.querySelector('.editor-heading')!.getBoundingClientRect().left)
        if (w.__run) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await p.waitForFunction(() => (window as unknown as { __x: number[] }).__x.length >= 2)
    await action()
    await p.waitForTimeout(900)
    return p.evaluate(() => {
      const w = window as unknown as { __x: number[]; __run: boolean }
      w.__run = false
      return w.__x
    })
  }
  const before = (await rect('.editor-heading')).l
  const closing = await sample(() => p.keyboard.press('Control+Backslash'))
  const after = (await rect('.editor-heading')).l
  // 收起后标题要让到左上角的展开按钮右边
  const btn = await p.getByRole('button', { name: /^显示侧栏/ }).evaluate((el) => el.getBoundingClientRect().right)
  expect(after).toBeGreaterThanOrEqual(btn)
  // 逐帧位置相邻帧步长平滑（无跳变）
  const steps = closing.slice(1).map((x, i) => x - closing[i])
  expect(closing.length).toBeGreaterThan(5)
  const limit = Math.max(60, Math.abs(after - before) * 0.5)
  expect(Math.max(...steps.map(Math.abs))).toBeLessThan(limit)
  const opening = await sample(() => p.keyboard.press('Control+Backslash'))
  const osteps = opening.slice(1).map((x, i) => x - opening[i])
  expect(Math.max(...osteps.map(Math.abs))).toBeLessThan(limit)
  expect(Math.abs((await rect('.editor-heading')).l - before)).toBeLessThan(2)
  if (shots) await p.screenshot({ path: resolve(shots, '桌面-1440-展开.png') })
  await c.close()
})

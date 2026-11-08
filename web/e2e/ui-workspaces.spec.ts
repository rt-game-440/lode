import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type BrowserContext, type Page, type WebSocket, expect, test } from '@playwright/test'

// #58：前端切换工作空间。侧栏顶部的工作空间名弹出列表（切换、新建），命令面板里的“切换工作空间”；
// 默认工作空间保持原有地址（/note/<id> 等），其他工作空间用 /w/<id>/...；同步引擎、IndexedDB、本机记忆按工作空间区分。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码）、visual.spec 之前。
// 第一个用例要求实例里还只有默认工作空间（e2e 每次运行前清空数据目录，前面的规格文件不会新建工作空间）。
// 设置 LODE_SCREENSHOTS=<目录名> 时截取切换器、新建对话框、手机布局和深色模式，输出到 docs/screenshots/<目录名>/。
const PASSWORD = 'e2e-test-password'
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''

test.describe.configure({ mode: 'serial' })

interface NoteRef {
  id: string
  path: string
  rev: number
}

/** 用例之间共用：第二个用例新建的工作空间和其中的笔记 */
let wsId = ''
let wsNote: NoteRef
/** 只用于检查服务器状态的上下文（不受 setOffline 影响） */
let server: BrowserContext

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

async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400) // 等菜单、对话框的入场动画结束
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

/** 在某个工作空间（默认为 default）里用 API 新建笔记 */
async function createNote(path: string, content: string, ws = 'default'): Promise<NoteRef> {
  const res = await server.request.post(`${apiBase(ws)}/notes`, { data: { path, content } })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

const apiBase = (ws: string) => (ws === 'default' ? '/api' : `/api/w/${ws}`)

async function serverNote(ws: string, id: string): Promise<{ content: string; rev: number }> {
  return (await server.request.get(`${apiBase(ws)}/notes/${id}`)).json()
}

async function serverPaths(ws: string): Promise<string[]> {
  const tree = await (await server.request.get(`${apiBase(ws)}/tree`)).json()
  return tree.notes.map((n: NoteRef) => n.path)
}

/** 记录页面打开过的 WebSocket（连接地址和收到的消息） */
function trackSockets(p: Page) {
  const sockets: { ws: WebSocket; frames: string[] }[] = []
  p.on('websocket', (ws) => {
    const s = { ws, frames: [] as string[] }
    ws.on('framereceived', (f) => s.frames.push(String(f.payload)))
    sockets.push(s)
  })
  return sockets
}

const switcher = (p: Page) => p.getByTestId('workspace-switcher')
const tree = (p: Page) => p.getByRole('tree', { name: '笔记' })
const treeItem = (p: Page, name: string) => tree(p).getByRole('treeitem', { name, exact: true })
const editor = (p: Page) => p.locator('.cm-content')
const syncStatus = (p: Page) => p.getByTestId('sync-status')
const homeTitle = (p: Page) => p.locator('.home-title')

/** 从侧栏的工作空间列表切换 */
async function switchVia(p: Page, name: string) {
  await switcher(p).click()
  await p.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
  await expect(switcher(p)).toHaveAccessibleName(`工作空间：${name}`)
}

const idbNames = (p: Page) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? '').sort())
const storageKeys = (p: Page) => p.evaluate(() => Object.keys(localStorage).sort())

test.beforeAll(async ({ browser }) => {
  server = await browser.newContext()
  await signIn(server)
})

test.afterAll(async () => {
  await server.close()
})

test('只有默认工作空间时，现有 URL 和书签照常可用，界面和原来一样', async ({ browser }) => {
  const list = (await (await server.request.get('/api/workspaces')).json()).workspaces
  expect(list.map((w: { id: string }) => w.id), '前置条件：只有默认工作空间').toEqual(['default'])
  const n = await createNote('书签/书签笔记.md', '书签原文 #书签标签\n')

  const { c, p } = await open(browser)
  const sockets = trackSockets(p)
  const prefixed: string[] = []
  p.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/w/')) prefixed.push(r.url())
  })

  await p.goto('/')
  await expect(homeTitle(p)).toHaveText('笔记')
  // 侧栏顶部是工作空间名（默认叫“笔记”），只多一个淡色的箭头
  await expect(switcher(p)).toHaveText('笔记')
  await expect(switcher(p)).not.toHaveClass(/has-many/)

  // 书签：原有地址直接打开
  await p.goto(`/note/${n.id}`)
  await expect(editor(p)).toContainText('书签原文')
  await expect(syncStatus(p)).toHaveText('已同步')
  await p.goto('/tag/书签标签')
  await expect(p.getByRole('heading', { name: '#书签标签', level: 1 })).toBeVisible()
  await expect(p.getByRole('button', { name: /书签笔记/ })).toBeVisible()
  await p.goto('/settings/appearance')
  await expect(p.getByRole('radiogroup', { name: '字号' })).toBeVisible()
  await p.goto('/trash')
  await expect(p.getByRole('heading', { name: '回收站', level: 1 })).toBeVisible()

  // 站内跳转生成的地址也不带前缀
  await p.goto('/')
  await treeItem(p, '书签笔记').click() // 打开过的笔记所在文件夹已自动展开
  await expect(p).toHaveURL(new RegExp(`/note/${n.id}$`))
  await expect(editor(p)).toContainText('书签原文')

  // WebSocket、IndexedDB、localStorage 都沿用原来的名字
  expect(sockets.map((s) => new URL(s.ws.url()).pathname)).toContain('/api/ws')
  expect(sockets.every((s) => new URL(s.ws.url()).pathname === '/api/ws')).toBe(true)
  await expect.poll(() => idbNames(p)).toContain('lode')
  expect((await idbNames(p)).filter((x) => x.startsWith('lode:'))).toEqual([])
  const keys = await storageKeys(p)
  expect(keys).toContain('lode.recent')
  expect(keys).toContain('lode.expanded')
  expect(keys.filter((k) => /^lode\.(recent|expanded|agent\.chat):/.test(k))).toEqual([])
  expect(prefixed).toEqual([])

  // 列表里只有它自己和一个“新建工作空间”
  await switcher(p).click()
  const menu = p.getByRole('menu')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1)
  await expect(menu.getByRole('menuitemradio', { name: /^笔记/ })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitem', { name: '新建工作空间…' })).toBeVisible()
  await shot(p, 'ws-single-menu')
  await p.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(switcher(p)).toBeFocused()
  await c.close()
})

test('新建工作空间 → 写笔记 → 切回默认空间看不到 → 再切回来笔记还在', async ({ browser }) => {
  const { c, p } = await open(browser)
  const sockets = trackSockets(p)
  await p.goto('/')
  await expect(syncStatus(p)).toHaveText('已同步')
  const defaultSocket = sockets.find((s) => new URL(s.ws.url()).pathname === '/api/ws')
  expect(defaultSocket).toBeTruthy()

  // 侧栏列表 → 新建
  await switcher(p).click()
  await p.getByRole('menuitem', { name: '新建工作空间…' }).click()
  const dialog = p.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新建工作空间' })).toBeVisible()
  await shot(p, 'ws-create-dialog')
  // 名称为空不能创建
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect(dialog.getByText('请输入名称')).toBeVisible()
  await dialog.getByLabel('名称').fill('工作')
  await dialog.getByRole('button', { name: '创建' }).click()

  // 新建后直接进入：地址是 /w/<id>，侧栏和首页标题换成新名字，笔记树是空的
  await expect(p).toHaveURL(/\/w\/[a-z0-9]{6}$/)
  wsId = new URL(p.url()).pathname.split('/')[2]
  await expect(p.getByText('已新建工作空间“工作”')).toBeVisible()
  await expect(switcher(p)).toHaveAccessibleName('工作空间：工作')
  await expect(switcher(p)).toHaveClass(/has-many/)
  await expect(homeTitle(p)).toHaveText('工作')
  await expect(treeItem(p, '书签')).toHaveCount(0)
  // 旧的 WebSocket 已断开，新的连到这个工作空间
  await expect.poll(() => defaultSocket!.ws.isClosed()).toBe(true)
  await expect.poll(() => sockets.some((s) => new URL(s.ws.url()).pathname === `/api/w/${wsId}/ws` && !s.ws.isClosed())).toBe(true)
  await expect(syncStatus(p)).toHaveText('已同步')

  // 写一篇笔记
  await p.getByTestId('new-note').click()
  const title = p.getByLabel('笔记标题')
  await expect(title).toBeFocused()
  await p.keyboard.type('工作计划')
  await p.keyboard.press('Enter')
  await expect(treeItem(p, '工作计划')).toBeVisible()
  await editor(p).click()
  await p.keyboard.type('只在工作空间里')
  await expect(p.getByTestId('save-status')).toHaveText('已保存')
  await expect(p).toHaveURL(new RegExp(`^[^?]*/w/${wsId}/note/[^/]+$`))
  const noteId = new URL(p.url()).pathname.split('/').pop()!
  await expect.poll(() => serverPaths(wsId)).toEqual(['工作计划.md'])
  expect(await serverPaths('default')).not.toContain('工作计划.md')
  wsNote = { id: noteId, path: '工作计划.md', rev: 0 }

  // 切回默认工作空间：看不到这篇笔记
  await switchVia(p, '笔记')
  await expect(p).toHaveURL(/\/$/)
  expect(new URL(p.url()).pathname).toBe('/')
  await expect(homeTitle(p)).toHaveText('笔记')
  await expect(treeItem(p, '书签')).toBeVisible()
  await expect(treeItem(p, '工作计划')).toHaveCount(0)
  await p.keyboard.press('Control+k')
  await p.keyboard.type('工作计划')
  await expect(p.getByRole('option', { name: /新建笔记“工作计划”/ })).toBeVisible()
  await expect(p.getByRole('option', { name: /^工作计划/ })).toHaveCount(0)
  await p.keyboard.press('Escape')
  await expect(p.getByRole('dialog', { name: '快速切换' })).toBeHidden()

  // 命令面板“切换工作空间”切回来：笔记还在
  await p.keyboard.press('Control+k')
  await p.keyboard.type('切换工作空间')
  const cmd = p.getByRole('option', { name: '切换工作空间：工作' })
  await expect(cmd).toBeVisible()
  await shot(p, 'ws-command-palette')
  await expect(cmd).toHaveAttribute('aria-selected', 'true')
  await p.keyboard.press('Enter')
  await expect(p).toHaveURL(new RegExp(`/w/${wsId}$`))
  await expect(switcher(p)).toHaveAccessibleName('工作空间：工作')
  await treeItem(p, '工作计划').click()
  await expect(editor(p)).toContainText('只在工作空间里')
  await expect(p).toHaveURL(new RegExp(`/w/${wsId}/note/${noteId}$`))

  // 其他工作空间的地址也能当书签：刷新后仍在这个工作空间
  await p.reload()
  await expect(editor(p)).toContainText('只在工作空间里')
  await expect(switcher(p)).toHaveAccessibleName('工作空间：工作')

  // 本机记忆按工作空间区分；默认工作空间的键名不变
  const recent = await p.evaluate((id) => [localStorage.getItem('lode.recent'), localStorage.getItem(`lode.recent:${id}`)], wsId)
  expect(JSON.parse(recent[1] ?? '[]')).toContain(noteId)
  expect(JSON.parse(recent[0] ?? '[]')).not.toContain(noteId)
  expect(await storageKeys(p)).toContain(`lode.expanded:${wsId}`)
  expect(await idbNames(p)).toEqual(expect.arrayContaining(['lode', `lode:${wsId}`]))

  // 浏览器后退可以跨工作空间：先回到工作空间首页，再回到默认工作空间
  await p.goBack()
  await expect(p).toHaveURL(new RegExp(`/w/${wsId}$`))
  await p.goBack()
  await expect.poll(() => new URL(p.url()).pathname).toBe('/')
  await expect(switcher(p)).toHaveAccessibleName('工作空间：笔记')
  await expect(treeItem(p, '书签')).toBeVisible()
  await expect(treeItem(p, '工作计划')).toHaveCount(0)
  await c.close()
})

test('在 A 空间离线编辑，切到 B 再切回 A，恢复网络后写队列补发成功', async ({ browser }) => {
  expect(wsId, '依赖上一个用例新建的工作空间').not.toBe('')
  const { c, p } = await open(browser)
  const original = (await serverNote(wsId, wsNote.id)).content

  // 在线时两个工作空间都打开过（笔记树和正文进入各自的离线缓存）
  await p.goto('/')
  await expect(treeItem(p, '书签')).toBeVisible()
  await p.waitForTimeout(800) // 笔记树缓存防抖 500ms
  await p.goto(`/w/${wsId}/note/${wsNote.id}`)
  await expect(editor(p)).toContainText(original.trim())
  await expect(syncStatus(p)).toHaveText('已同步')
  await p.waitForTimeout(800)

  await c.setOffline(true)
  await expect(syncStatus(p)).toHaveText('离线')
  await p.locator('.cm-line').first().click()
  await p.keyboard.press('End')
  await p.keyboard.type(' + A 离线修改')
  await expect(syncStatus(p)).toHaveText('离线（1 项待同步）')

  // 切到 B（默认工作空间）：离线也能切，B 没有待同步的修改，A 的修改没有发出
  await switchVia(p, '笔记')
  expect(new URL(p.url()).pathname).toBe('/')
  await expect(treeItem(p, '书签')).toBeVisible()
  await expect(syncStatus(p)).toHaveText('离线')
  expect((await serverNote(wsId, wsNote.id)).content).toBe(original)

  // 切回 A：写队列还在
  await switchVia(p, '工作')
  await expect(syncStatus(p)).toHaveText('离线（1 项待同步）')
  await treeItem(p, '工作计划').click()
  await expect(editor(p)).toContainText('只在工作空间里 + A 离线修改')

  // 恢复网络：补发到 A，服务器上的内容正确，默认工作空间不受影响
  await c.setOffline(false)
  await expect(syncStatus(p)).toHaveText('已同步')
  await expect.poll(async () => (await serverNote(wsId, wsNote.id)).content).toBe('只在工作空间里 + A 离线修改')
  expect(await serverPaths('default')).not.toContain('工作计划.md')
  await c.close()
})

test('两个标签页分别打开两个空间，各自实时同步，互不收到对方的变更', async ({ browser }) => {
  expect(wsId).not.toBe('')
  const x = await createNote('实时/默认这边.md', '默认原文\n')
  const y = await createNote('实时/工作这边.md', '工作原文\n', wsId)
  // 同一个浏览器的两个标签页（共用 localStorage 和 IndexedDB）
  const c = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  await signIn(c)
  const a = await c.newPage()
  const b = await c.newPage()
  const socketsA = trackSockets(a)
  const socketsB = trackSockets(b)
  await a.goto(`/note/${x.id}`)
  await b.goto(`/w/${wsId}/note/${y.id}`)
  await expect(editor(a)).toContainText('默认原文')
  await expect(editor(b)).toContainText('工作原文')
  await expect(syncStatus(a)).toHaveText('已同步')
  await expect(syncStatus(b)).toHaveText('已同步')
  await expect(switcher(a)).toHaveAccessibleName('工作空间：笔记')
  await expect(switcher(b)).toHaveAccessibleName('工作空间：工作')

  // 别处修改各自打开的笔记：2 秒内看到
  let res = await server.request.put(`/api/notes/${x.id}`, { data: { base_rev: x.rev, content: '默认原文，别处改了\n' } })
  expect(res.ok()).toBe(true)
  await expect(editor(a)).toContainText('默认原文，别处改了', { timeout: 2000 })
  res = await server.request.put(`/api/w/${wsId}/notes/${y.id}`, { data: { base_rev: y.rev, content: '工作原文，别处改了\n' } })
  expect(res.ok()).toBe(true)
  await expect(editor(b)).toContainText('工作原文，别处改了', { timeout: 2000 })

  // 新建的笔记只出现在自己的工作空间
  const x2 = await createNote('实时/默认新建.md', '默认新建\n')
  const y2 = await createNote('实时/工作新建.md', '工作新建\n', wsId)
  await expect(treeItem(a, '默认新建')).toBeVisible({ timeout: 2000 })
  await expect(treeItem(b, '工作新建')).toBeVisible({ timeout: 2000 })
  await a.waitForTimeout(800)
  await expect(treeItem(a, '工作新建')).toHaveCount(0)
  await expect(treeItem(b, '默认新建')).toHaveCount(0)
  await expect(editor(a)).not.toContainText('工作原文')
  await expect(editor(b)).not.toContainText('默认原文')

  // WebSocket 连在各自的工作空间上，收到的变更通知里没有对方的笔记
  const live = (s: { ws: WebSocket }[]) => s.filter((x) => !x.ws.isClosed())
  expect(live(socketsA).map((s) => new URL(s.ws.url()).pathname)).toEqual(['/api/ws'])
  expect(live(socketsB).map((s) => new URL(s.ws.url()).pathname)).toEqual([`/api/w/${wsId}/ws`])
  const framesA = socketsA.flatMap((s) => s.frames).join('\n')
  const framesB = socketsB.flatMap((s) => s.frames).join('\n')
  expect(framesA).toContain(x2.id)
  expect(framesB).toContain(y2.id)
  for (const id of [y.id, y2.id]) expect(framesA).not.toContain(id)
  for (const id of [x.id, x2.id]) expect(framesB).not.toContain(id)

  // 本机记忆也各记各的
  const [recent, recentWs] = await a.evaluate((id) => [localStorage.getItem('lode.recent'), localStorage.getItem(`lode.recent:${id}`)], wsId)
  expect(JSON.parse(recent ?? '[]')).not.toContain(y.id)
  expect(JSON.parse(recentWs ?? '[]')).not.toContain(x.id)
  await c.close()
})

test('键盘可以打开列表并切换；新组件通过无障碍扫描；助手在其他工作空间给出提示', async ({ browser }) => {
  expect(wsId).not.toBe('')
  for (const scheme of ['light', 'dark'] as const) {
    const { c, p } = await open(browser, { colorScheme: scheme, reducedMotion: 'reduce' })
    await p.goto('/')
    await expect(homeTitle(p)).toHaveText('笔记')
    await switcher(p).focus()
    await p.keyboard.press('Enter')
    const menu = p.getByRole('menu')
    // 打开时焦点在当前项上，方向键移到下一项，回车切换
    await expect(menu.getByRole('menuitemradio', { name: /^笔记/ })).toBeFocused()
    await shot(p, `ws-menu-${scheme}`)
    await p.waitForTimeout(400) // 菜单淡入结束后再测对比度
    const axe = await new AxeBuilder({ page: p })
      .include('[data-testid="workspace-switcher"]')
      .include('.menu')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(axe.violations.map((v) => `${v.id}：${v.nodes.map((n) => n.target.join(' ')).join('；')}`)).toEqual([])
    await p.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: /^工作/ })).toBeFocused()
    await p.keyboard.press('Enter')
    await expect(p).toHaveURL(new RegExp(`/w/${wsId}$`))
    await expect(homeTitle(p)).toHaveText('工作')

    // 助手对话暂时只支持默认工作空间（#61 之前）：给出提示和切回去的按钮
    if (scheme === 'light') {
      await p.getByTestId('open-agent').click()
      await expect(p).toHaveURL(new RegExp(`/w/${wsId}/agent$`))
      const notice = p.getByTestId('agent-unsupported')
      await expect(notice).toContainText('这个工作空间暂时不能用助手')
      await shot(p, 'ws-agent-unsupported')
      await notice.getByRole('button', { name: '切换到“笔记”' }).click()
      await expect(switcher(p)).toHaveAccessibleName('工作空间：笔记')
      expect(new URL(p.url()).pathname).toBe('/')
    }
    await c.close()
  }
})

test('手机布局：侧栏顶部的工作空间名可点区域不小于 44×44，可以切换', async ({ browser }) => {
  expect(wsId).not.toBe('')
  const { c, p } = await open(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  await p.goto('/')
  await expect(switcher(p)).toBeVisible()
  const size = await switcher(p).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const after = getComputedStyle(el, '::after')
    return { w: Math.max(r.width, parseFloat(after.width) || 0), h: Math.max(r.height, parseFloat(after.height) || 0) }
  })
  expect(size.w).toBeGreaterThanOrEqual(43.5)
  expect(size.h).toBeGreaterThanOrEqual(43.5)
  await switcher(p).tap()
  await expect(p.getByRole('menuitemradio', { name: /^工作/ })).toBeVisible()
  await shot(p, 'ws-mobile-menu')
  await p.getByRole('menuitemradio', { name: /^工作/ }).tap()
  await expect(p).toHaveURL(new RegExp(`/w/${wsId}$`))
  await expect(treeItem(p, '工作计划')).toBeVisible()
  await treeItem(p, '工作计划').tap()
  await expect(editor(p)).toContainText('只在工作空间里')
  await c.close()
})

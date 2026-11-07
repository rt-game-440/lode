import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type BrowserContext, type Page, expect, test } from '@playwright/test'

// 阶段 2：多端同步与 PWA。A、B 是同一账号的两个浏览器上下文（相当于两台设备）。
// 只在本地测试实例里使用的测试密码
const PASSWORD = 'e2e-test-password'
const CONFLICT_RE = /\.conflict-.+-\d{8}-\d{6}\.md$/

// 设置 LODE_SCREENSHOTS=stage-2 时在关键状态截图，输出到 docs/screenshots/stage-2/
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(300) // 等菜单、toast 的入场动画结束
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

interface NoteRef {
  id: string
  path: string
}

let ctxA: BrowserContext
let ctxB: BrowserContext
let a: Page
let b: Page

async function signIn(ctx: BrowserContext) {
  const status = await (await ctx.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await ctx.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await ctx.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

async function createNote(path: string, content: string): Promise<NoteRef> {
  const res = await ctxA.request.post('/api/notes', { data: { path, content } })
  expect(res.ok()).toBe(true)
  return res.json()
}

async function serverContent(id: string): Promise<string> {
  return (await (await ctxA.request.get(`/api/notes/${id}`)).json()).content
}

async function conflictCopies(): Promise<string[]> {
  const tree = await (await ctxA.request.get('/api/tree')).json()
  return tree.notes.map((n: NoteRef) => n.path).filter((p: string) => CONFLICT_RE.test(p))
}

const editor = (p: Page) => p.locator('.cm-content')
const line = (p: Page, i: number) => p.locator('.cm-line').nth(i)
const syncStatus = (p: Page) => p.getByTestId('sync-status')

/** 在第 i 行行尾输入文字 */
async function appendToLine(p: Page, i: number, text: string) {
  await line(p, i).click()
  await p.keyboard.press('End')
  await p.keyboard.type(text)
}

/** 打开笔记并等待正文载入 */
async function openNote(p: Page, n: NoteRef, text: string) {
  await p.goto(`/note/${n.id}`)
  await expect(editor(p)).toContainText(text)
}

test.beforeAll(async ({ browser }) => {
  ctxA = await browser.newContext()
  ctxB = await browser.newContext()
  await signIn(ctxA)
  await signIn(ctxB)
  a = await ctxA.newPage()
  b = await ctxB.newPage()
})

test.afterAll(async () => {
  await ctxA.close()
  await ctxB.close()
})

test('A 修改后，B 不刷新、2 秒内看到', async () => {
  const n = await createNote('同步/实时.md', '第一行\n')
  await openNote(a, n, '第一行')
  await openNote(b, n, '第一行')
  await expect(syncStatus(b)).toHaveText('已同步')

  await appendToLine(a, 0, '，A 刚写的')
  const typed = Date.now()
  await expect(editor(b)).toContainText('第一行，A 刚写的', { timeout: 2000 })
  console.log(`B 在 A 停止输入后 ${Date.now() - typed}ms 看到修改`)
})

test('B 离线编辑两篇显示“离线（2 项待同步）”，联网后同步到服务器，A 也看到', async () => {
  const x = await createNote('同步/离线 X.md', 'X 原文\n')
  const y = await createNote('同步/离线 Y.md', 'Y 原文\n')
  // B 在线时打开过两篇（正文进入本地缓存）
  await openNote(b, y, 'Y 原文')
  await openNote(b, x, 'X 原文')
  await openNote(a, x, 'X 原文')

  await ctxB.setOffline(true)
  await expect(syncStatus(b)).toHaveText('离线')
  await appendToLine(b, 0, ' + B 离线修改')
  await b.getByRole('tree', { name: '笔记' }).getByRole('treeitem', { name: '离线 Y' }).click()
  await expect(editor(b)).toContainText('Y 原文')
  await appendToLine(b, 0, ' + B 离线修改')
  await expect(syncStatus(b)).toHaveText('离线（2 项待同步）')
  await shot(b, 'sync-offline-pending')
  expect(await serverContent(x.id)).toBe('X 原文\n')

  await ctxB.setOffline(false)
  await expect(syncStatus(b)).toHaveText('已同步')
  await expect.poll(() => serverContent(x.id)).toBe('X 原文 + B 离线修改\n')
  await expect.poll(() => serverContent(y.id)).toBe('Y 原文 + B 离线修改\n')
  await expect(editor(a)).toContainText('X 原文 + B 离线修改')
})

test('A、B 改同一行生成冲突副本，两端都有提示', async () => {
  const n = await createNote('同步/冲突.md', '一\n\n二\n\n三\n')
  await openNote(a, n, '一')
  await openNote(b, n, '一')

  // B 断网后基于同一 rev 修改，A 先保存
  await ctxB.setOffline(true)
  await appendToLine(b, 0, ' B 改')
  await expect(syncStatus(b)).toHaveText('离线（1 项待同步）')
  await appendToLine(a, 0, ' A 改')
  await expect.poll(() => serverContent(n.id)).toBe('一 A 改\n\n二\n\n三\n')

  await ctxB.setOffline(false)
  await expect(b.getByText('“冲突”与其他设备的修改冲突，你的版本已另存为冲突副本')).toBeVisible()
  await expect(a.getByText('“冲突”在另一台设备上与你的修改冲突，已生成冲突副本')).toBeVisible()
  await expect(syncStatus(a)).toHaveText('有冲突')
  await expect(syncStatus(b)).toHaveText('有冲突')
  await shot(a, 'sync-conflict-remote-toast')
  await shot(b, 'sync-conflict-local-toast')
  // 点同步状态可以列出冲突副本
  await syncStatus(a).click()
  await expect(a.getByRole('menuitem', { name: /^冲突副本：冲突\.conflict-/ })).toBeVisible()
  await shot(a, 'sync-conflict-menu')
  await a.keyboard.press('Escape')

  // 服务器版本不变，B 的编辑器换成服务器版本，B 的版本在冲突副本里
  expect(await serverContent(n.id)).toBe('一 A 改\n\n二\n\n三\n')
  await expect(editor(b)).toContainText('一 A 改')
  const copies = (await conflictCopies()).filter((p) => p.startsWith('同步/冲突.conflict-'))
  expect(copies).toHaveLength(1)

  // 点提示打开冲突副本
  await b.getByRole('button', { name: '打开副本' }).click()
  await expect(editor(b)).toContainText('一 B 改')
  await expect(syncStatus(b)).not.toHaveText('有冲突')
})

test('A 改第 1 段、B 改第 3 段自动合并，不产生副本，两端最终一致', async () => {
  const n = await createNote('同步/合并.md', '一\n\n二\n\n三\n')
  await openNote(a, n, '一')
  await openNote(b, n, '一')
  const before = (await conflictCopies()).length

  await ctxB.setOffline(true)
  await appendToLine(b, 4, ' B')
  await expect(syncStatus(b)).toHaveText(/离线（1 项待同步）/)
  await appendToLine(a, 0, ' A')
  await expect.poll(() => serverContent(n.id)).toBe('一 A\n\n二\n\n三\n')

  await ctxB.setOffline(false)
  const merged = '一 A\n\n二\n\n三 B\n'
  await expect.poll(() => serverContent(n.id)).toBe(merged)
  await expect(line(b, 0)).toHaveText('一 A')
  await expect(line(b, 4)).toHaveText('三 B')
  await expect(line(a, 0)).toHaveText('一 A')
  await expect(line(a, 4)).toHaveText('三 B')
  expect((await conflictCopies()).length).toBe(before)
})

test('B 正在用输入法组字时推迟套用 A 的修改，组字结束后合并且不打断输入', async () => {
  const n = await createNote('同步/组字.md', '第一段\n\n第二段\n')
  await openNote(a, n, '第一段')
  await openNote(b, n, '第一段')

  // B 离线时改了第二段，A 改第一段：B 联网后服务器合并，合并结果会在 B 组字期间到达
  await ctxB.setOffline(true)
  await appendToLine(b, 2, 'x')
  await expect(syncStatus(b)).toHaveText('离线（1 项待同步）')
  await appendToLine(a, 0, ' A')
  await expect.poll(() => serverContent(n.id)).toBe('第一段 A\n\n第二段\n')

  // 用 Chromium 的 IME 接口模拟中文输入法：进入组字（拼音还没上屏）
  const cdp = await ctxB.newCDPSession(b)
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await expect(line(b, 2)).toHaveText('第二段xzhong')

  await ctxB.setOffline(false)
  await expect.poll(() => serverContent(n.id)).toBe('第一段 A\n\n第二段x\n')
  await b.waitForTimeout(800)
  // 组字期间 B 的编辑器不被替换，拼音仍在
  await expect(line(b, 0)).toHaveText('第一段')
  await expect(line(b, 2)).toHaveText('第二段xzhong')

  // 选字上屏：组字结束后套用合并结果并保存，两端一致
  await cdp.send('Input.insertText', { text: '中' })
  await expect(line(b, 0)).toHaveText('第一段 A')
  await expect(line(b, 2)).toHaveText('第二段x中')
  await expect.poll(() => serverContent(n.id)).toBe('第一段 A\n\n第二段x中\n')
  await expect(line(a, 2)).toHaveText('第二段x中')
})

test('PWA：manifest 齐全、service worker 激活，断网后刷新仍能看到笔记树并编辑缓存的笔记', async ({ browser }) => {
  const ctx = await browser.newContext()
  await signIn(ctx)
  const p = await ctx.newPage()
  const n = await createNote('同步/离线冷启动.md', '冷启动原文\n')

  await p.goto('/')
  await expect(p.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  const manifest = await (await ctx.request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ name: 'Lode', display: 'standalone', start_url: '/' })
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
  const icons = manifest.icons as { sizes: string; purpose?: string }[]
  expect(icons.some((i) => i.sizes === '192x192')).toBe(true)
  expect(icons.some((i) => i.sizes === '512x512' && i.purpose !== 'maskable')).toBe(true)
  expect(icons.some((i) => i.purpose?.includes('maskable'))).toBe(true)
  await expect(p.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png')
  expect((await ctx.request.get('/apple-touch-icon.png')).headers()['content-type']).toBe('image/png')

  await expect.poll(() => p.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated')

  // 在线时打开过的笔记会缓存正文
  await openNote(p, n, '冷启动原文')
  await p.waitForTimeout(800) // 笔记树缓存防抖 500ms

  await ctx.setOffline(true)
  await p.reload()
  const tree = p.getByRole('tree', { name: '笔记' })
  await expect(tree.getByRole('treeitem', { name: '同步' })).toBeVisible()
  await expect(editor(p)).toContainText('冷启动原文')
  await appendToLine(p, 0, '，离线追加')
  await expect(syncStatus(p)).toHaveText('离线（1 项待同步）')

  await ctx.setOffline(false)
  await expect.poll(() => serverContent(n.id)).toBe('冷启动原文，离线追加\n')
  await ctx.close()
})

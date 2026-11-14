import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { type APIRequestContext, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #72：在工作空间之间移动、复制笔记和文件夹。
// 右键菜单：只有一个工作空间时没有这两项；复制带图片的笔记到另一个空间的文件夹、移动文件夹（确认里提示会失效的链接），
// 切换过去后正文和图片正常；离线时两项禁用。拖到工作空间切换器：悬停展开列表，放下移动，按住 Alt 复制（含多选），Esc 取消不做改动。
// 自己启动一个 lode（系统临时目录、随机端口），不依赖公共实例的状态（ui-workspaces.spec 要求此前只有默认空间）。
const PASSWORD = 'e2e-test-password'

const root = resolve(import.meta.dirname, '..', '..')
const bin = process.env.LODE_BIN ?? join(root, 'bin', process.platform === 'win32' ? 'lode.exe' : 'lode')
// 设置 LODE_SCREENSHOTS=<目录名> 时截图（3 级验收）
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(root, 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(300)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

let dataDir = ''
let base = ''
let lode: ChildProcess | null = null
let output = ''
let ctx: BrowserContext
let api: APIRequestContext
let page: Page
let wsId = ''

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => ok(p))
    })
  })
}

async function startLode(port: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LODE_ADDR: `127.0.0.1:${port}`,
    LODE_DATA_DIR: dataDir,
    LODE_LOG_LEVEL: 'warn',
    LODE_SECRET_KEY: 'e2e-ws-transfer-secret',
  }
  const child = spawn(bin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (b) => (output += b))
  child.stderr!.on('data', (b) => (output += b))
  lode = child
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`lode 启动失败：\n${output}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return
    } catch {
      // 还没监听
    }
    if (Date.now() > deadline) throw new Error(`lode 启动超时：\n${output}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function stopLode() {
  const child = lode
  lode = null
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill()
  await exited
}

/** 生成一张纯色 PNG（宽 w、高 h），截图里看得见 */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const tree = (p: Page) => p.getByRole('tree', { name: '笔记' })
const treeItem = (p: Page, name: string) => tree(p).getByRole('treeitem', { name, exact: true })
const switcher = (p: Page) => p.getByTestId('workspace-switcher')
const menu = (p: Page) => p.getByRole('menu')

async function createNote(prefix: string, path: string, content: string) {
  const r = await api.post(`${prefix}/notes`, { data: { path, content } })
  expect(r.status(), await r.text()).toBe(201)
  return (await r.json()) as { id: string; path: string }
}

async function notePaths(prefix: string): Promise<string[]> {
  const t = await (await api.get(`${prefix}/tree`)).json()
  return (t.notes as { path: string }[]).map((n) => n.path).sort()
}

async function noteByPath(prefix: string, path: string) {
  const r = await api.get(`${prefix}/notes/by-path?path=${encodeURIComponent(path)}`)
  return r.ok() ? ((await r.json()) as { id: string; content: string }) : null
}

/** 打开笔记，等图片加载出来（naturalWidth > 0，没有显示成损坏） */
async function expectImageShown(p: Page) {
  const img = p.locator('.cm-image img').first()
  await expect(img).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0)
  await expect(p.locator('.cm-image-broken')).toHaveCount(0)
}

async function openTreeMenu(p: Page, name: string) {
  await treeItem(p, name).click({ button: 'right' })
  await expect(menu(p)).toBeVisible()
}

async function closeMenu(p: Page) {
  await p.keyboard.press('Escape')
  await expect(menu(p)).toBeHidden()
}

const center = async (p: Page, testId: string) => {
  const b = (await p.getByTestId(testId).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/**
 * 用真实的鼠标拖动把文件树里的一行拖到工作空间切换器上：悬停到列表展开，再移到目标空间上。
 * 返回目标项的位置，调用方决定放下、按 Alt 放下还是按 Esc。
 */
async function dragToSwitcher(p: Page, rowName: string) {
  await treeItem(p, rowName).hover()
  await p.mouse.down()
  const s = await center(p, 'workspace-switcher')
  await p.mouse.move(s.x, s.y, { steps: 8 })
  await expect(switcher(p)).toHaveClass(/is-drop-target/)
  await expect(p.getByTestId('workspace-drop-list')).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  dataDir = mkdtempSync(join(tmpdir(), 'lode-e2e-transfer-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  await startLode(port)
  ctx = await browser.newContext({ baseURL: base, locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  api = ctx.request
  expect((await api.post(`${base}/api/auth/setup`, { data: { password: PASSWORD } })).ok()).toBe(true)
  page = await ctx.newPage()
})

test.afterAll(async () => {
  await ctx?.close()
  await stopLode()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('只有一个工作空间时右键菜单里没有“移动到工作空间…”“复制到工作空间…”', async () => {
  // 默认空间：一篇带图片的笔记；一个文件夹，里面的笔记也引用这张图，另一篇笔记链接到它
  const up = await api.post('/api/attachments', { multipart: { file: { name: '封面.png', mimeType: 'image/png', buffer: png(160, 90, [52, 120, 246]) } } })
  expect(up.ok(), await up.text()).toBe(true)
  expect((await up.json()).path).toBe('attachments/封面.png')
  await createNote('/api', '带图.md', '# 带图\n\n跨空间复制的笔记\n\n![[封面.png]]\n')
  await createNote('/api', '项目/计划.md', '# 计划\n\n第一步\n\n![](attachments/封面.png)\n')
  await createNote('/api', '项目/进度.md', '# 进度\n\n见 [[计划]]\n')
  await createNote('/api', '索引.md', '# 索引\n\n- [[计划]]\n- [[带图]]\n')
  await createNote('/api', '拖走.md', '# 拖走\n\n拖到切换器上移动\n')
  await createNote('/api', '甲.md', '# 甲\n')
  await createNote('/api', '乙.md', '# 乙\n')
  await createNote('/api', '留下.md', '# 留下\n\nEsc 取消后还在这里\n')

  await page.goto('/')
  await expect(treeItem(page, '带图')).toBeVisible({ timeout: 10_000 })
  await openTreeMenu(page, '带图')
  await expect(menu(page).getByRole('menuitem', { name: '移到回收站' })).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: /工作空间…/ })).toHaveCount(0)
  await closeMenu(page)
  await openTreeMenu(page, '项目')
  await expect(menu(page).getByRole('menuitem', { name: '删除文件夹' })).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: /工作空间…/ })).toHaveCount(0)
  await closeMenu(page)
})

test('右键菜单复制带图片的笔记到另一个空间的文件夹：切换过去正文和图片正常，源笔记还在', async () => {
  const ws = await api.post('/api/workspaces', { data: { name: '工作' } })
  expect(ws.status(), await ws.text()).toBe(201)
  wsId = (await ws.json()).id
  const w = `/api/w/${wsId}`
  expect((await api.post(`${w}/folders`, { data: { path: '收件' } })).ok()).toBe(true)

  await page.reload()
  await expect(treeItem(page, '带图')).toBeVisible({ timeout: 10_000 })
  await openTreeMenu(page, '带图')
  await shot(page, 'transfer-menu')
  await menu(page).getByRole('menuitem', { name: '复制到工作空间…' }).click()
  const dialog = page.getByTestId('transfer-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading')).toHaveText('把笔记“带图”复制到工作空间')
  await expect(dialog.getByTestId(`transfer-target-${wsId}`)).toBeChecked()
  await expect(dialog.getByTestId('transfer-dir').locator('option')).toHaveCount(2)
  await dialog.getByTestId('transfer-dir').selectOption('收件')
  // 复制不提示失效链接
  await expect(dialog.getByTestId('transfer-broken-links')).toHaveCount(0)
  await shot(page, 'transfer-dialog-copy')
  await dialog.getByTestId('transfer-submit').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('已复制到“工作”')).toBeVisible()

  // 源笔记还在；目标空间多了笔记和图片
  expect(await notePaths('/api')).toContain('带图.md')
  expect(await notePaths(w)).toEqual(['收件/带图.md'])
  expect((await api.get(`${w}/files/attachments/${encodeURIComponent('封面.png')}`)).ok()).toBe(true)

  await page.goto(`/w/${wsId}`)
  await expect(switcher(page)).toContainText('工作')
  await treeItem(page, '收件').click()
  await treeItem(page, '带图').click()
  await expect(page.locator('.cm-content')).toContainText('跨空间复制的笔记')
  await expectImageShown(page)
  await shot(page, 'transfer-copied-note')
})

test('右键菜单移动文件夹：确认里提示会失效的链接，源文件夹进回收站，目标空间正文和图片正常', async () => {
  const w = `/api/w/${wsId}`
  await page.goto('/')
  await expect(treeItem(page, '项目')).toBeVisible({ timeout: 10_000 })
  await openTreeMenu(page, '项目')
  await menu(page).getByRole('menuitem', { name: '移动到工作空间…' }).click()
  const dialog = page.getByTestId('transfer-dialog')
  await expect(dialog.getByRole('heading')).toHaveText('把文件夹“项目”移动到工作空间')
  // 索引.md 里的 [[计划]]：1 个链接会失效（项目内部的 [[计划]] 跟着走，不算）
  await expect(dialog.getByTestId('transfer-broken-links')).toHaveText('其他笔记里指向它的 1 个链接会失效。')
  await shot(page, 'transfer-dialog-move')
  await dialog.getByTestId('transfer-submit').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('已移动到“工作”')).toBeVisible()
  await expect(treeItem(page, '项目')).toHaveCount(0)

  // 源：笔记进回收站，可以恢复（这里只看回收站，恢复由 Go 测试覆盖）
  const trash = (await (await api.get('/api/trash')).json()).items as { path: string }[]
  expect(trash.map((t) => t.path).sort()).toEqual(['项目/计划.md', '项目/进度.md'])
  // 默认空间的图片还在（移动不删源附件）
  expect((await api.get(`/api/files/attachments/${encodeURIComponent('封面.png')}`)).ok()).toBe(true)
  expect(await notePaths(w)).toEqual(['收件/带图.md', '项目/计划.md', '项目/进度.md'])
  expect((await noteByPath(w, '项目/进度.md'))!.content).toContain('[[计划]]')

  await page.goto(`/w/${wsId}`)
  await treeItem(page, '项目').click()
  await treeItem(page, '计划').click()
  await expect(page.locator('.cm-content')).toContainText('第一步')
  await expectImageShown(page)
  await shot(page, 'transfer-moved-folder')
})

test('离线时两项禁用并提示需要联网', async () => {
  await page.goto('/')
  await expect(treeItem(page, '带图')).toBeVisible({ timeout: 10_000 })
  await ctx.setOffline(true)
  try {
    await expect(page.getByText(/离线/).first()).toBeVisible({ timeout: 10_000 })
    await openTreeMenu(page, '带图')
    for (const name of ['移动到工作空间…', '复制到工作空间…']) {
      const item = menu(page).getByRole('menuitem', { name: new RegExp(name) })
      await expect(item).toBeDisabled()
      await expect(item).toContainText('需要联网')
    }
    await shot(page, 'transfer-menu-offline')
    await closeMenu(page)
  } finally {
    await ctx.setOffline(false)
  }
  await expect(page.getByText(/离线/)).toHaveCount(0, { timeout: 15_000 })
})

test('拖到工作空间切换器：悬停展开列表，放下移动到目标空间根目录', async () => {
  const w = `/api/w/${wsId}`
  await page.goto('/')
  await expect(treeItem(page, '拖走')).toBeVisible({ timeout: 10_000 })
  await dragToSwitcher(page, '拖走')
  // 当前空间不能放
  await expect(page.getByTestId('workspace-drop-default')).toHaveAttribute('aria-disabled', 'true')
  const t = await center(page, `workspace-drop-${wsId}`)
  await page.mouse.move(t.x, t.y, { steps: 6 })
  await expect(page.getByTestId(`workspace-drop-${wsId}`)).toHaveClass(/is-over/)
  await expect(page.getByTestId('workspace-drop-list')).toContainText('移动到')
  await shot(page, 'transfer-drag-hover')
  await page.mouse.up()
  await expect(page.getByTestId('workspace-drop-list')).toBeHidden()
  await expect(page.getByText('已移动到“工作”')).toBeVisible()
  await expect(treeItem(page, '拖走')).toHaveCount(0)
  expect(await notePaths(w)).toContain('拖走.md')
  expect(await notePaths('/api')).not.toContain('拖走.md')
})

test('按住 Alt 拖放为复制（多选的两篇一起）', async () => {
  const w = `/api/w/${wsId}`
  await treeItem(page, '甲').click()
  await treeItem(page, '乙').click({ modifiers: ['Control'] })
  await expect(treeItem(page, '甲')).toHaveClass(/is-selected/)
  await expect(treeItem(page, '乙')).toHaveClass(/is-selected/)
  await dragToSwitcher(page, '乙')
  const t = await center(page, `workspace-drop-${wsId}`)
  await page.keyboard.down('Alt')
  await page.mouse.move(t.x, t.y, { steps: 6 })
  await expect(page.getByTestId('workspace-drop-list')).toContainText('复制到')
  await shot(page, 'transfer-drag-alt-copy')
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(page.getByText('已复制到“工作”')).toBeVisible()
  expect(await notePaths(w)).toEqual(expect.arrayContaining(['甲.md', '乙.md']))
  // 复制：源还在
  expect(await notePaths('/api')).toEqual(expect.arrayContaining(['甲.md', '乙.md']))
  await page.keyboard.press('Escape')
})

test('拖动中按 Esc 取消：列表收起、不高亮，放下也不做任何改动', async () => {
  const w = `/api/w/${wsId}`
  const before = { src: await notePaths('/api'), dst: await notePaths(w) }
  await dragToSwitcher(page, '留下')
  const t = await center(page, `workspace-drop-${wsId}`)
  await page.mouse.move(t.x, t.y, { steps: 6 })
  await expect(page.getByTestId(`workspace-drop-${wsId}`)).toHaveClass(/is-over/)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workspace-drop-list')).toBeHidden()
  await expect(switcher(page)).not.toHaveClass(/is-drop-target/)
  // 取消后再回到切换器上也不再展开
  const s = await center(page, 'workspace-switcher')
  await page.mouse.move(s.x, s.y, { steps: 4 })
  await page.waitForTimeout(700)
  await expect(page.getByTestId('workspace-drop-list')).toHaveCount(0)
  await page.mouse.up()
  await page.waitForTimeout(500)
  expect(await notePaths('/api')).toEqual(before.src)
  expect(await notePaths(w)).toEqual(before.dst)
  await expect(treeItem(page, '留下')).toBeVisible()
})

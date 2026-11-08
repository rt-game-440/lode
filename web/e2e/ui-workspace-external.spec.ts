import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type APIRequestContext, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #60：外部目录工作空间。新建对话框里“使用已有文件夹”：路径不合法时在输入框下面给出原因；接入后对账出已有笔记，
// 在外部直接改文件、在 Lode 里改都能看到；外部目录里不出现 Lode 的任何文件；
// 删除时确认框写明“不会删除你的笔记文件”，删除后外部文件逐一校验哈希都没变。
// 自己启动一个 lode（系统临时目录、随机端口），不依赖公共实例的状态和其他规格文件的执行顺序。
const PASSWORD = 'e2e-test-password'

const root = resolve(import.meta.dirname, '..', '..')
const bin = process.env.LODE_BIN ?? join(root, 'bin', process.platform === 'win32' ? 'lode.exe' : 'lode')
// 设置 LODE_SCREENSHOTS=<目录名> 时截图（3 级验收）
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(root, 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(400)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

let dataDir = ''
let extDir = ''
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
    LODE_SECRET_KEY: 'e2e-ws-external-secret',
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

/** 目录里每个文件的相对路径和内容哈希 */
function hashes(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name
    if (statSync(join(dir, r)).isDirectory()) Object.assign(out, hashes(dir, r))
    else out[r] = createHash('sha256').update(readFileSync(join(dir, r))).digest('hex')
  }
  return out
}

const tree = (p: Page) => p.getByRole('tree', { name: '笔记' })
const treeItem = (p: Page, name: string) => tree(p).getByRole('treeitem', { name, exact: true })
const switcher = (p: Page) => p.getByTestId('workspace-switcher')

test.beforeAll(async ({ browser }) => {
  dataDir = mkdtempSync(join(tmpdir(), 'lode-e2e-wsext-data-'))
  // 像一个 Obsidian 库：笔记、子文件夹、.obsidian 配置、非 Markdown 附件
  extDir = mkdtempSync(join(tmpdir(), 'lode-e2e-wsext-vault-'))
  mkdirSync(join(extDir, '读书'))
  mkdirSync(join(extDir, '.obsidian'))
  writeFileSync(join(extDir, '首页.md'), '# 首页\n\n来自 Obsidian 库\n')
  writeFileSync(join(extDir, '读书', '书单.md'), '# 书单\n\n- 三体\n')
  writeFileSync(join(extDir, '.obsidian', 'app.json'), '{"alwaysUpdateLinks":true}')
  writeFileSync(join(extDir, '图.bin'), Buffer.from([0, 1, 2, 3]))

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
  if (extDir) rmSync(extDir, { recursive: true, force: true })
})

test('新建对话框：使用已有文件夹，路径不合法时在输入框下面给出各自的原因', async () => {
  await page.goto('/')
  await switcher(page).click()
  await page.getByRole('menuitem', { name: '新建工作空间…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新建工作空间' })).toBeVisible()
  // 默认不显示路径输入
  await expect(dialog.getByTestId('create-workspace-dir')).toHaveCount(0)
  await dialog.getByLabel('名称').fill('Obsidian 库')
  await dialog.getByTestId('create-workspace-external').check()
  await expect(dialog.getByRole('button', { name: '接入' })).toBeVisible()
  await expect(dialog.getByTestId('create-workspace-dir-note')).toContainText('不要让两个 Lode 实例使用同一个文件夹')
  await shot(page, 'ws-external-dialog')
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([])

  const dir = dialog.getByLabel('文件夹路径')
  const submit = dialog.getByRole('button', { name: '接入' })
  const cases: [string, string][] = [
    ['', '请填写文件夹的绝对路径'],
    ['相对/路径', '必须是绝对路径'],
    [join(extDir, '不存在'), '文件夹不存在'],
    [join(extDir, '首页.md'), '不是文件夹'],
    [dataDir, '数据目录'],
    [join(dataDir, 'vault'), '数据目录里面'],
  ]
  for (const [value, message] of cases) {
    await dir.fill(value)
    await submit.click()
    await expect(dialog.getByRole('alert')).toContainText(message)
  }
  await shot(page, 'ws-external-dialog-error')
  // 全部被拒绝，没有登记
  expect(((await (await api.get('/api/workspaces')).json()).workspaces as unknown[]).length).toBe(1)
  expect(hashes(extDir)['首页.md']).toBeTruthy()

  // 填对路径：接入并切换过去，已有笔记出现在文件树里
  await dir.fill(extDir)
  await submit.click()
  await expect(page).toHaveURL(/\/w\/[a-z0-9]{6}$/)
  wsId = new URL(page.url()).pathname.split('/')[2]
  await expect(page.getByText('已接入工作空间“Obsidian 库”')).toBeVisible()
  await expect(treeItem(page, '首页')).toBeVisible({ timeout: 10_000 })
  await expect(treeItem(page, '读书')).toBeVisible()
  await shot(page, 'ws-external-tree')

  const list = (await (await api.get('/api/workspaces')).json()).workspaces as { id: string; external: boolean; vault_dir?: string }[]
  const ext = list.find((w) => w.id === wsId)!
  expect(ext.external).toBe(true)
  expect(ext.vault_dir && existsSync(ext.vault_dir)).toBeTruthy()
  expect(list.find((w) => w.id === 'default')!.vault_dir).toBeUndefined()
})

test('外部目录里除了笔记什么都不多：Lode 的索引、回收站都在数据目录', async () => {
  // 已经对账、打开过：外部目录没有多出任何文件
  expect(hashes(extDir)).toEqual({
    '首页.md': expect.any(String),
    '读书/书单.md': expect.any(String),
    '.obsidian/app.json': expect.any(String),
    '图.bin': expect.any(String),
  })
  expect(existsSync(join(dataDir, 'workspaces', wsId, 'index.db'))).toBe(true)
  expect(existsSync(join(dataDir, 'workspaces', wsId, 'trash'))).toBe(true)
  expect(existsSync(join(dataDir, 'workspaces', wsId, 'vault'))).toBe(false)
})

test('在外部直接改文件，Lode 里能看到；在 Lode 里改，外部文件跟着变', async () => {
  const w = `/api/w/${wsId}`
  // 外部新增一篇、改一篇
  writeFileSync(join(extDir, '新来的.md'), '# 新来的\n\n在 Obsidian 里写的\n')
  writeFileSync(join(extDir, '首页.md'), '# 首页\n\n在 Obsidian 里改过\n')
  await expect(treeItem(page, '新来的')).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(async () => (await (await api.get(`${w}/notes/by-path?path=${encodeURIComponent('首页.md')}`)).json()).content)
    .toContain('在 Obsidian 里改过')

  // Lode 里改
  const note = await (await api.get(`${w}/notes/by-path?path=${encodeURIComponent('首页.md')}`)).json()
  const put = await api.put(`${w}/notes/${note.id}`, { data: { content: '# 首页\n\n在 Lode 里又改了\n', base_rev: note.rev } })
  expect(put.ok(), await put.text()).toBe(true)
  expect(readFileSync(join(extDir, '首页.md'), 'utf8')).toContain('在 Lode 里又改了')
  // Lode 里新建
  expect((await api.post(`${w}/notes`, { data: { path: '读书/新建.md', content: '# 新建\n' } })).status()).toBe(201)
  expect(existsSync(join(extDir, '读书', '新建.md'))).toBe(true)
  // Lode 里删除：外部文件被移走，进的是数据目录里的回收站，外部目录里不出现回收站
  const nw = await (await api.get(`${w}/notes/by-path?path=${encodeURIComponent('新来的.md')}`)).json()
  expect((await api.delete(`${w}/notes/${nw.id}`)).ok()).toBe(true)
  expect(existsSync(join(extDir, '新来的.md'))).toBe(false)
  expect(readdirSync(join(dataDir, 'workspaces', wsId, 'trash')).length).toBeGreaterThan(0)
  expect(readdirSync(extDir).some((n) => n.toLowerCase().includes('trash'))).toBe(false)
})

test('设置页：外部空间显示路径；删除确认框写明不会删除笔记文件，删除后外部文件一个都不动', async () => {
  await page.goto(`/settings/workspaces/${wsId}`)
  await expect(page.getByTestId('workspace-path')).toContainText(extDir.replace(/\\/g, '/').split('/').pop()!)
  await expect(page.getByText('外部目录')).toBeVisible()
  const before = hashes(extDir)
  await page.getByTestId('workspace-delete').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('删除工作空间“Obsidian 库”？')
  await expect(dialog.getByTestId('workspace-delete-external-note')).toContainText('不会删除你的笔记文件')
  await expect(dialog).toContainText('一个都不会动')
  await shot(page, 'ws-external-delete-confirm')
  await dialog.getByRole('button', { name: '删除' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => ((await (await api.get('/api/workspaces')).json()).workspaces as unknown[]).length).toBe(1)
  expect(hashes(extDir)).toEqual(before)
  expect(existsSync(join(dataDir, 'workspaces', wsId))).toBe(false)
  expect(readdirSync(join(dataDir, 'trash-workspaces')).some((n) => n.startsWith(`${wsId}-`))).toBe(true)
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// 导入本地文档：侧栏“导入笔记”菜单选择文件 / 文件夹，重名自动改名，非文本文件和隐藏目录被跳过。
// 文件名排在 smoke 之后、visual 之前。
const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page
let tmp = ''

test.beforeAll(async ({ browser }) => {
  tmp = mkdtempSync(join(tmpdir(), 'lode-import-'))
  page = await browser.newPage({ locale: 'zh-CN' })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
})

test.afterAll(async () => {
  await page.close()
  rmSync(tmp, { recursive: true, force: true })
})

const tree = () => page.getByRole('tree', { name: '笔记' })

async function importVia(item: '导入文件…' | '导入文件夹…', files: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]) {
  await page.getByTestId('import-notes').click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: item }).click(),
  ])
  await chooser.setFiles(files)
}

test('导入多个文件：txt 改成 .md、GBK 正确解码、非文本文件被跳过', async () => {
  await page.goto('/')
  // 空库时文件树显示空状态，不渲染 tree，所以等导入按钮
  await expect(page.getByTestId('import-notes')).toBeVisible()
  await importVia('导入文件…', [
    { name: 'imp-a.md', mimeType: 'text/markdown', buffer: Buffer.from('# 甲\r\n正文\r\n') },
    // “中文”的 GBK 编码
    { name: 'imp-b.txt', mimeType: 'text/plain', buffer: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) },
    { name: 'imp-c.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50]) },
  ])
  await expect(page.getByText('已导入 2 篇，跳过 1 个')).toBeVisible()
  await expect(tree().getByRole('treeitem', { name: /imp-a/ })).toBeVisible()
  await expect(tree().getByRole('treeitem', { name: /imp-b/ })).toBeVisible()
  expect(readFileSync(join(vault, 'imp-a.md'), 'utf8')).toBe('# 甲\r\n正文\r\n')
  expect(readFileSync(join(vault, 'imp-b.md'), 'utf8')).toBe('中文')
  expect(existsSync(join(vault, 'imp-c.png'))).toBe(false)
})

test('重名导入自动改名，不覆盖已有笔记', async () => {
  await importVia('导入文件…', [{ name: 'imp-a.md', mimeType: 'text/markdown', buffer: Buffer.from('第二份') }])
  await expect.poll(() => existsSync(join(vault, 'imp-a 1.md'))).toBe(true)
  expect(readFileSync(join(vault, 'imp-a 1.md'), 'utf8')).toBe('第二份')
  expect(readFileSync(join(vault, 'imp-a.md'), 'utf8')).toBe('# 甲\r\n正文\r\n')
})

test('导入文件夹保留目录结构并跳过隐藏目录', async () => {
  const dir = join(tmp, 'imp-dir')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  mkdirSync(join(dir, '.obsidian'))
  writeFileSync(join(dir, 'sub', 'x.md'), '嵌套笔记')
  writeFileSync(join(dir, 'top.md'), '顶层笔记')
  writeFileSync(join(dir, '.obsidian', 'cfg.md'), '不该导入')
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'note.md'), '不该导入')
  await importVia('导入文件夹…', dir)
  // 其他用例的提示可能还在，所以用本用例独有的“跳过 2 个”
  await expect(page.getByText('已导入 2 篇，跳过 2 个')).toBeVisible()
  const root = basename(dir)
  expect(readFileSync(join(vault, root, 'sub', 'x.md'), 'utf8')).toBe('嵌套笔记')
  expect(readFileSync(join(vault, root, 'top.md'), 'utf8')).toBe('顶层笔记')
  expect(existsSync(join(vault, root, '.obsidian'))).toBe(false)
  await expect(tree().getByRole('treeitem', { name: new RegExp(root) })).toBeVisible()
})

test('文件夹右键菜单可导入到该文件夹', async () => {
  const root = basename(join(tmp, 'imp-dir'))
  await tree().getByRole('treeitem', { name: new RegExp(root) }).click({ button: 'right' })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: '导入文件…' }).click(),
  ])
  await chooser.setFiles([{ name: 'imp-menu.md', mimeType: 'text/markdown', buffer: Buffer.from('菜单导入') }])
  await expect.poll(() => existsSync(join(vault, root, 'imp-menu.md'))).toBe(true)
  expect(readFileSync(join(vault, root, 'imp-menu.md'), 'utf8')).toBe('菜单导入')
})

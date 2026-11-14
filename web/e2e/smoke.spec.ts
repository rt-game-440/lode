import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')
// 只在本地测试实例里使用的测试密码
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

const tree = () => page.getByRole('tree', { name: '笔记' })
const editorText = () => page.locator('.cm-content')

async function openSidebarTab(name: '文件' | '搜索' | '标签') {
  await page.getByRole('tab', { name }).click()
}

test('首启设置密码后进入应用', async () => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '欢迎使用 Lode' })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByLabel('确认密码').fill(PASSWORD)
  await page.getByRole('button', { name: '设置密码并进入' }).click()
  await expect(page.getByRole('heading', { name: '笔记' })).toBeVisible()
})

test('新建笔记、输入、自动保存、刷新、磁盘一致、搜索、删除与恢复', async () => {
  await page.getByTestId('new-note').click()
  const title = page.getByLabel('笔记标题')
  await expect(title).toBeFocused()
  await page.keyboard.type('冒烟测试')
  await page.keyboard.press('Enter')
  await expect(tree().getByRole('treeitem', { name: '冒烟测试' })).toBeVisible()

  const body = '你好 Lode，这是全文搜索冒烟测试的正文。'
  await editorText().click()
  await page.keyboard.type(body)
  await expect(page.getByTestId('save-status')).toHaveText('已保存')

  await page.reload()
  await expect(editorText()).toHaveText(body)
  expect(readFileSync(join(vault, '冒烟测试.md'), 'utf8')).toBe(body)

  await openSidebarTab('搜索')
  await page.getByLabel('搜索全部笔记').fill('全文搜索')
  const hit = page.getByRole('listitem').filter({ hasText: '冒烟测试' })
  await expect(hit).toBeVisible()
  await expect(hit.locator('mark')).toHaveText('全文搜索')

  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '移到回收站' }).click()
  await expect(page.getByText('“冒烟测试”已移到回收站')).toBeVisible()
  expect(existsSync(join(vault, '冒烟测试.md'))).toBe(false)
  // 搜索结果在 vault 变化后约 200ms 刷新；等它消失再打开回收站，否则两处都匹配“冒烟测试”
  await expect(hit).toBeHidden()

  await page.getByRole('button', { name: '回收站' }).click()
  const row = page.getByRole('listitem').filter({ hasText: '冒烟测试' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '恢复' }).click()
  await expect(page.getByText('已恢复“冒烟测试”')).toBeVisible()
  await openSidebarTab('文件')
  await expect(tree().getByRole('treeitem', { name: '冒烟测试' })).toBeVisible()
  expect(readFileSync(join(vault, '冒烟测试.md'), 'utf8')).toBe(body)
})

test('外部修改约 2 秒内反映到文件树和搜索结果', async () => {
  await openSidebarTab('文件')
  const started = Date.now()
  writeFileSync(join(vault, '外部笔记.md'), '这是从外部编辑器写入的内容')
  await expect(tree().getByRole('treeitem', { name: '外部笔记' })).toBeVisible({ timeout: 3000 })
  const elapsed = Date.now() - started
  console.log(`外部新建在 ${elapsed}ms 后出现在文件树`)

  await openSidebarTab('搜索')
  await page.getByLabel('搜索全部笔记').fill('外部编辑器')
  await expect(page.getByRole('listitem').filter({ hasText: '外部笔记' })).toBeVisible({ timeout: 3000 })

  // 外部修改已有笔记的正文
  writeFileSync(join(vault, '外部笔记.md'), '内容被外部改成了独角兽')
  await page.getByLabel('搜索全部笔记').fill('独角兽')
  await expect(page.getByRole('listitem').filter({ hasText: '外部笔记' })).toBeVisible({ timeout: 3000 })
})

test('重命名笔记后更新其他笔记中的链接，反链显示正确', async () => {
  const create = async (path: string, content: string) => {
    const res = await page.request.post('/api/notes', { data: { path, content } })
    expect(res.ok()).toBe(true)
  }
  await create('链接目标.md', '# 目标')
  await create('链接源.md', '指向 [[链接目标]] 的笔记')

  await openSidebarTab('文件')
  await tree().getByRole('treeitem', { name: '链接目标' }).click()
  await expect(page.getByTestId('note-title')).toHaveText('链接目标')
  await page.getByTestId('note-title').click()
  const title = page.getByLabel('笔记标题')
  await title.fill('新目标')
  await title.press('Enter')
  await expect(page.getByText('已更新 1 篇笔记中的链接')).toBeVisible()
  expect(readFileSync(join(vault, '链接源.md'), 'utf8')).toBe('指向 [[新目标]] 的笔记')

  await page.getByRole('tab', { name: '反链' }).click()
  await expect(page.getByRole('list', { name: '反向链接' }).getByText('链接源')).toBeVisible()

  // wikilink 补全
  await tree().getByRole('treeitem', { name: '链接源' }).click()
  await expect(editorText()).toContainText('新目标')
  await editorText().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' [[新')
  const option = page.locator('.cm-tooltip-autocomplete li').filter({ hasText: '新目标' })
  await expect(option).toBeVisible()
  // CodeMirror 补全弹出后有约 75ms 的交互延迟，期间回车不会选中候选
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('save-status')).toHaveText('已保存')
  expect(readFileSync(join(vault, '链接源.md'), 'utf8')).toBe('指向 [[新目标]] 的笔记 [[新目标]]')
})

test('重命名正在编辑的笔记时，其中的自链接同步更新且之后的保存不冲突', async () => {
  const res = await page.request.post('/api/notes', { data: { path: '自链.md', content: '回到 [[自链]] 开头' } })
  expect(res.ok()).toBe(true)
  await openSidebarTab('文件')
  await tree().getByRole('treeitem', { name: '自链', exact: true }).click()
  await expect(page.getByTestId('note-title')).toHaveText('自链')
  await page.getByTestId('note-title').click()
  const title = page.getByLabel('笔记标题')
  await title.fill('自链改名')
  await title.press('Enter')
  await expect(editorText()).toContainText('[[自链改名]]')

  await editorText().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('。')
  await expect(page.getByTestId('save-status')).toHaveText('已保存')
  expect(readFileSync(join(vault, '自链改名.md'), 'utf8')).toBe('回到 [[自链改名]] 开头。')
})

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// 拖入文件即导入并打开。Playwright 无法真拖系统文件，所以在页面里用 DataTransfer 派发拖放事件；
// 真实的“拖入文件夹”（webkitGetAsEntry）由 dropped.test.ts 覆盖，并列在人工清单里。
// 文件名排在 smoke 之后、visual 之前。
const vault = resolve(import.meta.dirname, '..', '.e2e-data', 'vault')
const PASSWORD = 'e2e-test-password'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'zh-CN' })
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
  // 一个现成的文件夹，用来测“拖到文件夹行”
  const res = await page.request.post('/api/notes', { data: { path: 'drop-folder/seed.md', content: '种子' } })
  expect(res.ok()).toBe(true)
})

test.afterAll(async () => {
  await page.close()
})

type Dropped = { name: string; type: string; text: string }

/** 在 selector 命中的元素上依次派发 dragenter / dragover / drop；返回 dragover 是否被接管（defaultPrevented）。 */
async function dropFiles(selector: string, files: Dropped[], phase: 'drop' | 'over' = 'drop') {
  return page.evaluate(
    ({ selector, files, phase }) => {
      const target = document.querySelector(selector)!
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }))
      const fire = (type: string) => {
        const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })
        target.dispatchEvent(ev)
        return ev.defaultPrevented
      }
      fire('dragenter')
      const prevented = fire('dragover')
      if (phase === 'drop') fire('drop')
      return prevented
    },
    { selector, files, phase },
  )
}

const overlay = () => page.getByTestId('drop-overlay')

test('拖入 .md 文件：导入并自动打开', async () => {
  await page.goto('/')
  await expect(page.getByTestId('import-notes')).toBeVisible()
  await dropFiles('.shell-main, .mobile-layer, body', [{ name: 'drop-a.md', type: '', text: '# 拖入的笔记\n\n正文' }])
  await expect(page).toHaveURL(/\/note\//)
  await expect(page.locator('.cm-content')).toContainText('拖入的笔记')
  expect(readFileSync(join(vault, 'drop-a.md'), 'utf8')).toBe('# 拖入的笔记\n\n正文')
})

test('拖到文件夹行：导入到该文件夹', async () => {
  await page.goto('/')
  const row = page.getByRole('tree', { name: '笔记' }).getByRole('treeitem', { name: /drop-folder/ })
  await expect(row).toBeVisible()
  await row.evaluate((el) => el.setAttribute('data-e2e-folder', '1'))
  await dropFiles('[data-e2e-folder="1"]', [{ name: 'drop-b.txt', type: 'text/plain', text: '文本' }])
  await expect.poll(() => existsSync(join(vault, 'drop-folder', 'drop-b.md'))).toBe(true)
  await expect(page).toHaveURL(/\/note\//)
})

test('md 和图片一起拖入：笔记导入，图片被跳过并提示', async () => {
  await page.goto('/')
  await expect(page.getByTestId('import-notes')).toBeVisible()
  await dropFiles('body', [
    { name: 'drop-c.md', type: '', text: 'C' },
    { name: 'drop-c.png', type: 'image/png', text: 'x' },
  ])
  await expect(page.getByText('已导入 1 篇，跳过 1 个').last()).toBeVisible()
  expect(existsSync(join(vault, 'drop-c.md'))).toBe(true)
  expect(existsSync(join(vault, 'drop-c.png'))).toBe(false)
})

test('拖拽期间显示遮罩，离开窗口后消失；只有图片不接管', async () => {
  await page.goto('/')
  await expect(page.getByTestId('import-notes')).toBeVisible()
  await dropFiles('body', [{ name: 'x.md', type: '', text: 'x' }], 'over')
  await expect(overlay()).toBeVisible()
  await expect(overlay()).toContainText('根目录')
  await page.evaluate(() => document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null })))
  await expect(overlay()).toBeHidden()

  const prevented = await dropFiles('body', [{ name: 'p.png', type: 'image/png', text: 'x' }], 'over')
  // 兜底监听会 preventDefault 并把 dropEffect 设为 none（不让浏览器直接打开图片），但不显示导入遮罩
  expect(prevented).toBe(true)
  await expect(overlay()).toBeHidden()
})

test('应用内拖动笔记不触发导入遮罩', async () => {
  await page.goto('/')
  await expect(page.getByTestId('import-notes')).toBeVisible()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('application/x-lode-item', JSON.stringify({ kind: 'note', id: 'nope' }))
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(overlay()).toBeHidden()
})

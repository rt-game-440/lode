import { resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// #46：“添加模型”弹窗内容超高时表单区可滚动，标题和底部按钮固定，确定（保存）始终在视口内可点。
// 勾选“推理”会多出“默认推理强度”一行，正好把弹窗撑高，是复现超高的最小步骤。
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-e2e-1234'
const shotStage = process.env.LODE_SCREENSHOTS

async function signIn(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

/** 视口内的可见矩形：按钮的上下边都要落在视口高度之内。 */
async function expectInViewport(page: Page, locator: ReturnType<Page['getByTestId']>) {
  const box = await locator.boundingBox()
  const vh = page.viewportSize()?.height ?? 0
  expect(box, '元素应有可见的包围盒').not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh)
}

// overflows：这个视口下勾选推理后表单区是否超高（超高时必须可滚动）
for (const [name, viewport, overflows] of [
  ['桌面 1280×600', { width: 1280, height: 600 }, true],
  ['手机 390×844', { width: 390, height: 844 }, false],
] as const) {
  test(`${name}：勾选推理后添加模型，保存按钮在视口内且可点`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await signIn(page)

    // 先添加一个供应商（只保存，不测连接），进入它的页面再添加模型
    await page.goto('/settings/agent')
    await page.getByTestId('add-provider').click()
    await page.getByTestId('provider-name').fill('溢出测试')
    await page.getByTestId('provider-base-url').fill('http://127.0.0.1:9/v1')
    await page.getByTestId('provider-key').fill(MOCK_KEY)
    await page.getByTestId('provider-save').click()
    await expect(page).toHaveURL(/\/settings\/agent\/[^/]+$/)

    await page.getByTestId('add-model').click()
    const dialog = page.locator('[role="dialog"]:not([data-testid="settings-dialog"])')
    await expect(dialog).toBeVisible()
    await page.getByTestId('model-id').fill('overflow-reasoner')
    await page.getByTestId('model-reasoning').check()
    await expect(dialog.getByText('默认推理强度')).toBeVisible()

    // 标题和保存按钮都在视口内；内容超高时表单区滚动，而不是把按钮挤出去
    const save = page.getByTestId('model-save')
    const title = dialog.getByRole('heading', { name: '添加模型', level: 2 })
    await expect(title).toBeVisible()
    await expectInViewport(page, save)

    // 超高时表单区可以滚动，滚到底后标题和按钮仍在视口内
    const fields = dialog.locator('.modal-form-fields')
    const scrollable = await fields.evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(scrollable).toBe(overflows)
    if (overflows) {
      await fields.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
    }
    await expectInViewport(page, title)
    await expectInViewport(page, save)
    // 两列输入框不超出面板右缘（窄屏下曾撑出去）
    const panel = await dialog.boundingBox()
    const maxOutput = await page.getByTestId('model-max-output').boundingBox()
    expect(maxOutput!.x + maxOutput!.width).toBeLessThanOrEqual(panel!.x + panel!.width)
    // 设置 LODE_SCREENSHOTS=<目录名> 时把截图存到 docs/screenshots/<目录名>/，供人工检查
    if (shotStage) {
      await page.screenshot({ path: resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage, `add-model-reasoning-${viewport.width}x${viewport.height}.png`) })
    }
    await save.click()

    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('model-row')).toHaveCount(1)
    await expect(page.getByTestId('model-row')).toContainText('overflow-reasoner')
  })
}

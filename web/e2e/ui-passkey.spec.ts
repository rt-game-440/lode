import { type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// #28：通行密钥。用 Chrome DevTools 协议的虚拟认证器（WebAuthn.addVirtualAuthenticator）跑完整流程：
// 登记 → 查看 → 退出 → 通行密钥登录 → 删除 → 删除后不能再登录。
// 通行密钥绑定域名，不能用 IP，所以本 spec 通过 http://localhost:<端口> 访问（localhost 是安全上下文）。
// 文件名排在 smoke.spec 之后（smoke 的第一个用例要求实例尚未设置密码），在 visual.spec 之前。
const PASSWORD = 'e2e-test-password'
const port = Number(process.env.LODE_E2E_PORT ?? 18787)
const LOCAL = `http://localhost:${port}`
const IP = `http://127.0.0.1:${port}`

test.describe.configure({ mode: 'serial' })

let ctx: BrowserContext
let page: Page
let cdp: CDPSession
let authenticatorId = ''

async function signIn(c: BrowserContext, base: string) {
  const status = await (await c.request.get(`${base}/api/auth/status`)).json()
  if (!status.initialized) {
    expect((await c.request.post(`${base}/api/auth/setup`, { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await c.request.post(`${base}/api/auth/login`, { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

/** 添加一个支持可发现凭据和用户验证的内置认证器（等同指纹/面容/系统 PIN，自动通过）。 */
async function addAuthenticator() {
  const { authenticatorId: id } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  authenticatorId = id
}

async function removeAuthenticator() {
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: LOCAL, locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  await signIn(ctx, LOCAL)
  page = await ctx.newPage()
  cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await addAuthenticator()
})

test.afterAll(async () => {
  // 清理：留下的通行密钥不影响其它 spec，但不要把测试数据带出去
  const list = await (await ctx.request.get(`${LOCAL}/api/passkeys`)).json().catch(() => ({ passkeys: [] }))
  for (const p of list.passkeys ?? []) await ctx.request.delete(`${LOCAL}/api/passkeys/${p.id}`)
  await ctx.close()
})

const logoutButton = () => page.getByRole('button', { name: '退出登录', exact: true })
const passkeyLoginButton = () => page.getByRole('button', { name: '使用通行密钥登录' })
const list = () => page.getByRole('list', { name: '通行密钥列表' })

async function logout() {
  // 设置是桌面浮窗，打开时下面的页面不可操作：先回到首页
  await page.goto('/')
  await logoutButton().click()
  await page.getByRole('dialog', { name: '退出登录？' }).getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
}

async function addPasskey(name: string) {
  await page.getByLabel('名称', { exact: true }).fill(name)
  await page.getByRole('button', { name: '添加通行密钥' }).click()
}

test('设置里可以登记通行密钥，列表显示名称、创建时间和最后使用', async () => {
  await page.goto('/settings')
  await expect(logoutButton()).toBeVisible()
  const entry = page.getByTestId('settings-passkeys')
  await expect(entry).toContainText('未登记')
  await entry.click()
  await expect(page).toHaveURL(/\/settings\/passkeys$/)
  await expect(page.getByRole('heading', { name: '通行密钥', level: 1 })).toBeVisible()
  await expect(page.getByText('还没有通行密钥')).toBeVisible()

  await addPasskey('我的电脑')
  const items = list().getByRole('listitem')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText('我的电脑')
  await expect(items.first()).toContainText('创建于')
  await expect(items.first()).toContainText('从未使用')
  // 虚拟认证器里确实有了一个可发现凭据
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]!.isResidentCredential).toBe(true)
})

test('同一个认证器不能重复登记，换一个设备可以再登记一个', async () => {
  await addPasskey('重复')
  await expect(page.getByText('这个设备上的通行密钥已经登记过了。')).toBeVisible()
  await expect(list().getByRole('listitem')).toHaveCount(1)

  // 换成另一个认证器（模拟手机）登记第二个
  await removeAuthenticator()
  await addAuthenticator()
  await page.getByLabel('名称', { exact: true }).fill('手机')
  await page.getByRole('button', { name: '添加通行密钥' }).click()
  await expect(list().getByRole('listitem')).toHaveCount(2)
  await expect(page.getByTestId('passkeys-page').getByText('手机', { exact: true })).toBeVisible()
})

test('退出后登录页出现通行密钥按钮，一步登录并更新最后使用时间', async () => {
  await logout()
  await expect(passkeyLoginButton()).toBeVisible()
  // 密码输入仍然保留
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await passkeyLoginButton().click()
  await expect(logoutButton()).toBeVisible()

  await page.goto('/settings/passkeys')
  const phone = list().getByRole('listitem').filter({ hasText: '手机' })
  await expect(phone).toContainText('最后使用')
  await expect(phone).not.toContainText('从未使用')
  await expect(list().getByRole('listitem').filter({ hasText: '我的电脑' })).toContainText('从未使用')
})

test('删除通行密钥需要确认，删除后不能再用它登录，密码登录不受影响', async () => {
  const phone = list().getByRole('listitem').filter({ hasText: '手机' })
  await phone.getByRole('button', { name: /删除通行密钥/ }).click()
  const dialog = page.getByRole('dialog', { name: '删除“手机”？' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(list().getByRole('listitem')).toHaveCount(2)

  await phone.getByRole('button', { name: /删除通行密钥/ }).click()
  await page.getByRole('dialog', { name: '删除“手机”？' }).getByRole('button', { name: '删除', exact: true }).click()
  await expect(list().getByRole('listitem')).toHaveCount(1)
  await expect(list()).not.toContainText('手机')

  // 认证器里还有这个凭据，但服务端已经不认它
  await logout()
  await expect(passkeyLoginButton()).toBeVisible() // 另一个通行密钥还在，按钮仍然显示
  await passkeyLoginButton().click()
  await expect(page.getByRole('alert')).toContainText('通行密钥验证失败')
  await expect(page.getByRole('heading', { name: '登录 Lode' })).toBeVisible()

  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(logoutButton()).toBeVisible()
})

test('全部删除后登录页不再显示通行密钥按钮', async () => {
  await page.goto('/settings/passkeys')
  await list().getByRole('listitem').first().getByRole('button', { name: /删除通行密钥/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('还没有通行密钥')).toBeVisible()
  await logout()
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await expect(passkeyLoginButton()).toHaveCount(0)
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(logoutButton()).toBeVisible()
})

test('非安全上下文不显示通行密钥选项（设置入口和登录页按钮），密码登录正常', async ({ browser }) => {
  // 先在 localhost 上登记一个，让服务端认为“有通行密钥”，再模拟 window.isSecureContext 为 false
  await page.goto('/settings/passkeys')
  await addPasskey('临时')
  await expect(list().getByRole('listitem')).toHaveCount(1)

  const c = await browser.newContext({ baseURL: LOCAL, locale: 'zh-CN' })
  await c.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }))
  const p = await c.newPage()
  await p.goto('/')
  await expect(p.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
  await expect(p.getByLabel('密码', { exact: true })).toBeVisible()
  await expect(p.getByRole('button', { name: '使用通行密钥登录' })).toHaveCount(0)
  await p.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: '登录', exact: true }).click()
  await expect(p.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await p.goto('/settings')
  await expect(p.getByTestId('settings-home')).toBeVisible()
  await expect(p.getByTestId('settings-passkeys')).toHaveCount(0)
  // 直接打开子页面：给出原因，不提供登记表单
  await p.goto('/settings/passkeys')
  await expect(p.getByText('当前访问方式不能使用通行密钥')).toBeVisible()
  await expect(p.getByRole('button', { name: '添加通行密钥' })).toHaveCount(0)
  await c.close()
})

test('经 IP 地址访问（即使是 127.0.0.1 这样的安全上下文）也不显示通行密钥选项', async ({ browser }) => {
  const c = await browser.newContext({ baseURL: IP, locale: 'zh-CN' })
  const p = await c.newPage()
  await p.goto('/')
  await expect(p.getByRole('heading', { name: '登录 Lode' })).toBeVisible()
  await expect(p.getByRole('button', { name: '使用通行密钥登录' })).toHaveCount(0)
  // 服务端同样拒绝：登录接口返回 passkey_unsupported
  const res = await c.request.post(`${IP}/api/auth/passkey/begin`)
  expect(res.status()).toBe(400)
  expect((await res.json()).code).toBe('passkey_unsupported')
  await p.getByLabel('密码', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: '登录', exact: true }).click()
  await expect(p.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await p.goto('/settings')
  await expect(p.getByTestId('settings-passkeys')).toHaveCount(0)
  await c.close()
})

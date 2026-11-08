import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type APIRequestContext, type BrowserContext, type CDPSession, type Page, expect, test } from '@playwright/test'

// #29：用通行密钥（WebAuthn PRF）保护助手 API key。
// 公共测试实例设置了 LODE_SECRET_KEY（这时功能不可用），所以本 spec 自己启动一个不带 LODE_SECRET_KEY 的 lode：
// 数据目录在系统临时目录里，端口随机，可以真正重启来验证“重启后锁定”。
// Chrome 的虚拟认证器（WebAuthn.addVirtualAuthenticator，hasPrf: true）实现了 PRF（CTAP2 hmac-secret），
// 覆盖开启 → 重启锁定 → 通行密钥登录解锁 → 锁定/解锁 → 关闭。通行密钥绑定域名，所以通过 http://localhost 访问。

// 只在本地测试实例里使用的测试密码和模拟供应商 key
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-e2e-1234'
const REPLY = '你好，我是模拟助手。'

const root = resolve(import.meta.dirname, '..', '..')
const bin = process.env.LODE_BIN ?? join(root, 'bin', process.platform === 'win32' ? 'lode.exe' : 'lode')

// 设置 LODE_SCREENSHOTS=issue-29 时截图（3 级验收）
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(root, 'docs', 'screenshots', shotStage) : ''
async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(300)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })

// ---- 自己的 lode 实例 ----

let dataDir = ''
let port = 0
let base = ''
let lode: ChildProcess | null = null
let output = ''

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

async function startLode() {
  const env: NodeJS.ProcessEnv = { ...process.env, LODE_ADDR: `127.0.0.1:${port}`, LODE_DATA_DIR: dataDir, LODE_LOG_LEVEL: 'info' }
  delete env.LODE_SECRET_KEY
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

async function restartLode() {
  await stopLode()
  await startLode()
}

const secretFile = () => join(dataDir, 'secret.key')

/** 数据目录里所有文件（递归）的内容是否包含 needle。.lock 是空的进程锁文件（Windows 上被锁定无法读取），跳过。 */
function dataDirContains(needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.lock') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (readFileSync(p).includes(needle)) hits.push(p)
    }
  }
  walk(dataDir)
  return hits
}

// ---- 模拟的 OpenAI 兼容服务 ----

let mock: Server
let mockBase = ''

async function handle(req: IncomingMessage, res: ServerResponse) {
  for await (const _ of req) {
    // 读完请求体
  }
  if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }))
    return
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: REPLY } }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    res.end('data: [DONE]\n\n')
    return
  }
  res.writeHead(404)
  res.end()
}

// ---- 浏览器 ----

let ctx: BrowserContext
let page: Page
let cdp: CDPSession
let api: APIRequestContext
let providerId = ''

const logoutButton = () => page.getByRole('button', { name: '退出登录', exact: true })
const state = () => page.getByTestId('key-protection-state')
const toggle = () => page.getByTestId('key-protection-switch')

async function protection() {
  const res = await api.get(`${base}/api/key-protection`)
  expect(res.ok()).toBe(true)
  return (await res.json()).key_protection as { enabled: boolean; unlocked: boolean; wrapped: number }
}

async function providerTest() {
  return api.post(`${base}/api/agent/providers/${providerId}/test`)
}

test.beforeAll(async ({ browser }) => {
  mock = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`

  dataDir = mkdtempSync(join(tmpdir(), 'lode-e2e-protect-'))
  port = await freePort()
  base = `http://localhost:${port}`
  await startLode()

  ctx = await browser.newContext({ baseURL: base, locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  api = ctx.request
  expect((await api.post(`${base}/api/auth/setup`, { data: { password: PASSWORD } })).ok()).toBe(true)
  // 模拟供应商和模型（第一个模型自动成为默认模型）
  const created = await api.post(`${base}/api/agent/providers`, {
    data: { name: '模拟', kind: 'openai', base_url: `${mockBase}/v1`, api_key: MOCK_KEY },
  })
  expect(created.status()).toBe(201)
  providerId = (await created.json()).id
  expect((await api.post(`${base}/api/agent/providers/${providerId}/models`, { data: { model: 'mock-model', context_window: 32000, max_output: 4096 } })).status()).toBe(201)

  page = await ctx.newPage()
  cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  })
})

test.afterAll(async () => {
  await ctx?.close()
  await stopLode()
  await new Promise((r) => mock?.close(r))
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await info.attach('lode 输出', { body: output, contentType: 'text/plain' })
})

test('开启：用支持 PRF 的通行密钥开启后，数据目录里不再有能解开 API key 的东西，助手照常可用', async () => {
  expect(existsSync(secretFile())).toBe(true)
  const oldMaster = readFileSync(secretFile(), 'utf8').trim()
  expect(oldMaster.length).toBeGreaterThan(20)

  await page.goto('/settings/passkeys')
  await page.getByLabel('名称', { exact: true }).fill('电脑')
  await page.getByRole('button', { name: '添加通行密钥' }).click()
  await expect(page.getByRole('list', { name: '通行密钥列表' }).getByRole('listitem')).toHaveCount(1)
  await expect(toggle()).not.toBeChecked()
  await expect(toggle()).toBeEnabled()

  await toggle().click()
  const dialog = page.getByRole('dialog', { name: '用通行密钥保护 API key？' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '继续' }).click()
  await expect(state()).toContainText('已解锁')
  await expect(state()).toContainText('1 个通行密钥可以解锁')
  await expect(toggle()).toBeChecked()
  await expect(page.getByRole('list', { name: '通行密钥列表' })).toContainText('可解锁 API key')
  await shot(page, 'protect-enabled')

  // 数据目录：没有 secret.key，任何文件里都没有旧主密钥和明文 key
  expect(existsSync(secretFile())).toBe(false)
  expect(dataDirContains(oldMaster)).toEqual([])
  expect(dataDirContains(MOCK_KEY)).toEqual([])

  const res = await providerTest()
  expect(res.ok()).toBe(true)
  expect((await res.json()).ok).toBe(true)
})

test('重启后锁定：助手调用给出明确错误，设置页提示已锁定', async () => {
  await restartLode()
  expect(existsSync(secretFile())).toBe(false)
  expect(await protection()).toMatchObject({ enabled: true, unlocked: false, wrapped: 1 })

  const locked = await providerTest()
  expect(locked.status()).toBe(409)
  const body = await locked.json()
  expect(body.code).toBe('keys_locked')
  expect(body.message).toContain('通行密钥')

  // 发消息同样被拒绝（助手面板把这条说明显示为错误提示）
  const chat = await api.post(`${base}/api/agent/chats`, { data: {} })
  expect(chat.status()).toBe(201)
  const send = await api.post(`${base}/api/agent/chats/${(await chat.json()).id}/messages`, { data: { text: '你好' } })
  expect(send.status()).toBe(409)
  expect((await send.json()).message).toContain('锁定')

  // 笔记页的助手弹窗里发消息：错误提示（toast 在弹窗之上）给出同样的说明
  const note = await api.post(`${base}/api/notes`, { data: { path: '锁定测试.md', content: '# 锁定测试\n' } })
  expect(note.ok()).toBe(true)
  await page.goto(`/note/${(await note.json()).id}`)
  await page.locator('.editor-bar').getByRole('button', { name: '助手', exact: true }).click()
  const popup = page.getByTestId('agent-popup')
  await expect(popup).toBeVisible()
  await popup.getByTestId('agent-input').fill('你好')
  await popup.getByTestId('agent-send').click()
  await expect(page.locator('.toasts')).toContainText('锁定')
  await expect(popup).toBeVisible()
  await shot(page, 'agent-popup-locked')

  await page.goto('/settings/agent')
  await expect(page.getByTestId('keys-locked-notice')).toBeVisible()
  await shot(page, 'agent-locked-notice')
  await page.goto('/settings/passkeys')
  await expect(state()).toContainText('已锁定')
  await expect(page.getByTestId('key-protection-unlock')).toBeVisible()
  await shot(page, 'protect-locked')
})

test('通行密钥登录即解锁，助手可以正常对话', async () => {
  await logoutButton().click()
  await page.getByRole('dialog', { name: '退出登录？' }).getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '使用通行密钥登录' }).click()
  await expect(logoutButton()).toBeVisible()
  expect(await protection()).toMatchObject({ enabled: true, unlocked: true })

  expect((await (await providerTest()).json()).ok).toBe(true)
  const chat = await (await api.post(`${base}/api/agent/chats`, { data: {} })).json()
  expect((await api.post(`${base}/api/agent/chats/${chat.id}/messages`, { data: { text: '你好' } })).status()).toBe(202)
  await expect
    .poll(async () => JSON.stringify(await (await api.get(`${base}/api/agent/chats/${chat.id}`)).json()), { timeout: 10_000 })
    .toContain(REPLY)

  await page.goto('/settings/agent')
  await expect(page.getByRole('heading', { name: '助手', level: 1 })).toBeVisible()
  await expect(page.getByTestId('keys-locked-notice')).toHaveCount(0)
})

test('设置里可以立即锁定，再用通行密钥解锁', async () => {
  await page.goto('/settings/passkeys')
  await page.getByTestId('key-protection-lock').click()
  await expect(state()).toContainText('已锁定')
  expect((await providerTest()).status()).toBe(409)

  await page.getByTestId('key-protection-unlock').click()
  await expect(state()).toContainText('已解锁')
  expect((await (await providerTest()).json()).ok).toBe(true)
})

test('关闭：主密钥写回 secret.key，已保存的 key 不丢，重启后不再锁定', async () => {
  await toggle().click()
  const dialog = page.getByRole('dialog', { name: '关闭通行密钥保护？' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(toggle()).not.toBeChecked()
  await expect(state()).toContainText('开启后数据目录里不再保存主密钥')
  expect(existsSync(secretFile())).toBe(true)
  expect((await (await providerTest()).json()).ok).toBe(true)

  await restartLode()
  expect(await protection()).toMatchObject({ enabled: false, wrapped: 0 })
  const res = await providerTest()
  expect(res.ok()).toBe(true)
  expect((await res.json()).ok).toBe(true)
})

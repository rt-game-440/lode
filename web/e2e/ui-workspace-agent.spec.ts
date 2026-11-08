import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type APIRequestContext, type BrowserContext, type Page, expect, test } from '@playwright/test'

// #61：助手按工作空间隔离。在新工作空间里和助手对话并让它创建笔记：笔记出现在新工作空间、默认工作空间里没有；
// 助手的列表工具只看得到当前工作空间的笔记；切回默认工作空间后对话列表里没有这条对话；
// 在 A 空间生成时切到 B 空间，生成照常完成。
// 和 talk-to-agent.spec 一样用 node:http 起模拟的 OpenAI 兼容服务（按对话进度返回固定剧本）。
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

// ---- 自己的 lode 实例 ----

let dataDir = ''
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

async function startLode(port: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LODE_ADDR: `127.0.0.1:${port}`,
    LODE_DATA_DIR: dataDir,
    LODE_LOG_LEVEL: 'warn',
    LODE_SECRET_KEY: 'e2e-ws-agent-secret',
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

// ---- 模拟的 OpenAI 兼容服务 ----

interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

let mock: Server
let mockBase = ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

async function stream(res: ServerResponse, text: string, call?: { name: string; args: unknown }, delay = 0) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
  for (const piece of text.match(/.{1,4}/gsu) ?? []) {
    send({ choices: [{ index: 0, delta: { content: piece } }] })
    if (delay) await sleep(delay)
  }
  if (call) {
    send({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: `call_${call.name}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
        },
      ],
    })
  }
  send({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })
  res.end('data: [DONE]\n\n')
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }))
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404)
    res.end()
    return
  }
  const body = JSON.parse(await readBody(req)) as { messages: ChatMessage[] }
  const msgs = body.messages
  const last = msgs[msgs.length - 1]
  if (last.role === 'tool') {
    const prev = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length)
    const name = prev?.tool_calls?.[0].function.name
    if (name === 'create_note') await stream(res, '已创建：会议记录.md。')
    else await stream(res, `这个空间里的笔记：${String(last.content)}`)
    return
  }
  const said = JSON.stringify(last.content)
  if (said.includes('新建')) {
    await stream(res, '好的，我来新建。', { name: 'create_note', args: { path: '会议记录.md', content: '# 会议记录\n\n由助手创建。\n' } })
  } else if (said.includes('列出')) {
    await stream(res, '我先看一下有哪些笔记。', { name: 'list_notes', args: { recursive: true } })
  } else if (said.includes('慢速')) {
    await stream(res, '慢速回复到这里就结束了，不受切换工作空间影响。', undefined, 250)
  } else {
    await stream(res, '收到。')
  }
}

// ---- 浏览器 ----

let ctx: BrowserContext
let page: Page
let api: APIRequestContext
let wsId = ''

const apiBase = (ws: string) => (ws === 'default' ? '/api' : `/api/w/${ws}`)
const switcher = () => page.getByTestId('workspace-switcher')
const panel = () => page.getByTestId('agent-panel')

async function switchVia(name: string) {
  await switcher().click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
  await expect(switcher()).toHaveAccessibleName(`工作空间：${name}`)
}

async function chatsOf(ws: string): Promise<{ id: string; title: string }[]> {
  const res = await api.get(`${base}${apiBase(ws)}/agent/chats`)
  expect(res.ok()).toBe(true)
  return (await res.json()).chats
}

async function noteStatus(ws: string, path: string): Promise<number> {
  return (await api.get(`${base}${apiBase(ws)}/notes/by-path`, { params: { path } })).status()
}

async function ask(text: string) {
  await panel().getByTestId('agent-input').fill(text)
  await panel().getByTestId('agent-send').click()
}

test.beforeAll(async ({ browser }) => {
  mock = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`

  dataDir = mkdtempSync(join(tmpdir(), 'lode-e2e-wsagent-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  await startLode(port)

  ctx = await browser.newContext({ baseURL: base, locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  api = ctx.request
  expect((await api.post(`${base}/api/auth/setup`, { data: { password: PASSWORD } })).ok()).toBe(true)
  // 全局只配置一份供应商和模型（第一个模型自动成为默认模型），所有工作空间共用
  const p = await api.post(`${base}/api/agent/providers`, { data: { name: '模拟', kind: 'openai', base_url: mockBase } })
  expect(p.ok(), await p.text()).toBe(true)
  const m = await api.post(`${base}/api/agent/providers/${(await p.json()).id}/models`, {
    data: { model: 'mock-model', context_window: 32000, max_output: 4096 },
  })
  expect(m.ok(), await m.text()).toBe(true)
  const ws = await api.post(`${base}/api/workspaces`, { data: { name: '工作' } })
  expect(ws.status()).toBe(201)
  wsId = (await ws.json()).id
  expect((await api.post(`${base}/api/notes`, { data: { path: '默认笔记.md', content: '# 默认笔记\n' } })).ok()).toBe(true)
  expect((await api.post(`${base}${apiBase(wsId)}/notes`, { data: { path: '工作笔记.md', content: '# 工作笔记\n' } })).ok()).toBe(true)
  page = await ctx.newPage()
})

test.afterAll(async () => {
  await ctx?.close()
  await stopLode()
  await new Promise((r) => mock?.close(r))
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('在新空间里和助手对话并让它创建笔记：笔记在新空间，默认空间里没有；助手只看得到这个空间的笔记', async () => {
  test.setTimeout(60_000)
  await page.goto(`/w/${wsId}/agent`)
  await expect(panel()).toBeVisible()
  // 不再提示“这个工作空间暂时不能用助手”
  await expect(page.getByTestId('agent-unsupported')).toHaveCount(0)
  await expect(panel().getByTestId('agent-input')).toBeVisible()

  await ask('帮我新建一篇会议记录')
  const approval = panel().getByTestId('approval-card')
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(approval).toContainText('会议记录.md')
  await shot(page, 'ws-agent-approval')
  // 批准前新空间里还没有这篇笔记
  expect(await noteStatus(wsId, '会议记录.md')).toBe(404)
  await approval.getByRole('button', { name: '批准' }).click()
  await expect(panel().getByTestId('msg-assistant').last()).toContainText('已创建：会议记录.md', { timeout: 15_000 })

  expect(await noteStatus(wsId, '会议记录.md')).toBe(200)
  expect(await noteStatus('default', '会议记录.md')).toBe(404)
  const defaultTree = await (await api.get(`${base}/api/tree`)).json()
  expect(JSON.stringify(defaultTree)).not.toContain('会议记录')

  // 助手的目录工具只列出本空间的笔记
  await ask('列出所有笔记')
  const reply = panel().getByTestId('msg-assistant').last()
  await expect(reply).toContainText('这个空间里的笔记', { timeout: 15_000 })
  await expect(reply).toContainText('工作笔记.md')
  await expect(reply).toContainText('会议记录.md')
  await expect(reply).not.toContainText('默认笔记.md')
  await shot(page, 'ws-agent-list')
})

test('切回默认空间：对话列表里没有这条对话；默认空间的对话也不会出现在新空间里', async () => {
  test.setTimeout(60_000)
  expect(await chatsOf(wsId)).toHaveLength(1)
  expect(await chatsOf('default')).toHaveLength(0)

  await switchVia('笔记')
  await page.goto('/agent')
  await expect(panel()).toBeVisible()
  await panel().getByRole('button', { name: '全部对话' }).click()
  await expect(page.getByText('还没有对话')).toBeVisible()
  await shot(page, 'ws-agent-default-empty')

  // 在默认空间也聊一句，再回新空间：列表里只有新空间自己的那条
  await page.goto('/agent')
  await ask('你好')
  await expect(panel().getByTestId('msg-assistant').last()).toContainText('收到', { timeout: 15_000 })
  expect(await chatsOf('default')).toHaveLength(1)
  expect(await chatsOf(wsId)).toHaveLength(1)

  await switchVia('工作')
  await page.goto(`/w/${wsId}/agent`)
  await panel().getByRole('button', { name: '全部对话' }).click()
  await expect(panel().locator('.chat-open')).toHaveCount(1)
  await expect(panel().locator('.chat-open')).toContainText('帮我新建一篇会议记录')
  await expect(panel().locator('.chat-open')).not.toContainText('你好')
  await shot(page, 'ws-agent-list-ws')
})

test('在新空间里生成时切到默认空间，生成不受影响，切回来看到完整回复', async () => {
  test.setTimeout(60_000)
  await page.goto(`/w/${wsId}/agent`)
  await panel().getByTestId('agent-new-chat').click()
  await ask('请慢速回答')
  await expect(panel().getByTestId('msg-draft')).toContainText('慢速', { timeout: 15_000 })
  await expect(panel().getByTestId('agent-stop')).toBeVisible()

  await switchVia('笔记')
  // 默认空间的助手面板里看不到那条正在生成的对话
  await page.goto('/agent')
  await expect(panel().getByTestId('agent-input')).toBeVisible()
  await expect(panel()).not.toContainText('请慢速回答')
  await expect(panel().getByTestId('msg-draft')).toHaveCount(0)

  // 服务端上这条对话照常生成完成（写进新空间自己的库）
  await expect
    .poll(
      async () => {
        const c = (await chatsOf(wsId)).find((x) => x.title.includes('慢速'))
        if (!c) return ''
        const view = await (await api.get(`${base}${apiBase(wsId)}/agent/chats/${c.id}`)).json()
        return view.running ? '' : JSON.stringify(view.messages)
      },
      { timeout: 20_000 },
    )
    .toContain('不受切换工作空间影响')

  await switchVia('工作')
  await page.goto(`/w/${wsId}/agent`)
  await panel().getByRole('button', { name: '全部对话' }).click()
  await panel().locator('.chat-open', { hasText: '请慢速回答' }).click()
  await expect(panel().getByTestId('msg-assistant').last()).toContainText('不受切换工作空间影响')
  expect(await chatsOf('default')).toHaveLength(1)
})

test('手机宽度：新空间里的助手可用', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${wsId}/agent`)
  await expect(panel()).toBeVisible()
  await expect(panel().getByTestId('agent-input')).toBeVisible()
  await shot(page, 'ws-agent-mobile')
})

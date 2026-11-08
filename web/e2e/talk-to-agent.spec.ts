import { mkdirSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'

// 阶段 5：助手完整流程。用 node:http 起一个模拟的 OpenAI 兼容服务（/v1/models 和流式 /v1/chat/completions），
// 按对话进度返回固定剧本：先读笔记、再申请修改、批准后回复完成；换模型后回复里带上收到的模型 ID。
// 文件名排在 smoke、sync 之后（需要已完成首次设置）、visual 之前。

// 只在本地测试实例里使用的测试密码和模拟供应商 key
const PASSWORD = 'e2e-test-password'
const MOCK_KEY = 'sk-mock-e2e-1234'

// 设置 LODE_SCREENSHOTS=stage-5 时录屏（3 级验收），并放慢模拟的流式输出，便于看清
const shotStage = process.env.LODE_SCREENSHOTS
const shotDir = shotStage ? resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots', shotStage) : ''
const chunkDelay = shotDir ? 140 : 60

async function shot(p: Page, name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await p.waitForTimeout(300)
  await p.screenshot({ path: resolve(shotDir, `${name}.png`) })
}

test.use({ video: shotDir ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off' })

interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

let mock: Server
let mockBase = ''
/** 模拟服务收到的请求，用来确认模型切换和工具结果确实传到了供应商 */
const received: { model: string; auth: string }[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

/** 把一次回复写成 OpenAI 流式格式：文本分块输出，然后是工具调用和用量。 */
async function stream(res: ServerResponse, text: string, call?: { name: string; args: unknown }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
  for (const piece of text.match(/.{1,4}/gsu) ?? []) {
    send({ choices: [{ index: 0, delta: { content: piece } }] })
    await sleep(chunkDelay)
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
  send({ choices: [], usage: { prompt_tokens: 1800, completion_tokens: 60 } })
  res.end('data: [DONE]\n\n')
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-smart' }, { id: 'mock-fast' }] }))
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404)
    res.end()
    return
  }
  const body = JSON.parse(await readBody(req)) as { model: string; messages: ChatMessage[] }
  received.push({ model: body.model, auth: 'ok' })
  const msgs = body.messages
  const last = msgs[msgs.length - 1]
  if (last.role === 'tool') {
    const prev = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length)
    const name = prev?.tool_calls?.[0].function.name
    if (name === 'read_note') {
      const { rev } = JSON.parse(String(last.content)) as { rev: number }
      await stream(res, '看到了，现在把“买牛奶”勾上。', {
        name: 'update_note',
        args: { path: '待办.md', base_rev: rev, mode: 'patch', edits: [{ old: '- [ ] 买牛奶', new: '- [x] 买牛奶' }] },
      })
      return
    }
    await stream(res, '已经改好了：**买牛奶** 勾上了。')
    return
  }
  const said = JSON.stringify(last.content)
  if (said.includes('勾上')) {
    await stream(res, '好的，我先读一下这篇笔记，确认清单的写法。', { name: 'read_note', args: { path: '待办.md' } })
    return
  }
  await stream(res, `这是 ${body.model} 的回复。`)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`
})

test.afterAll(async () => {
  await new Promise((r) => mock.close(r))
})

async function signIn(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json()
  if (!status.initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password: PASSWORD } })).ok()).toBe(true)
  } else if (!status.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  }
}

test('添加供应商和模型 → 对话 → 流式回复 → 工具卡片 → 批准写入 → 编辑器更新 → 切换模型', async ({ page }, info) => {
  test.setTimeout(90_000)
  await signIn(page)
  const created = await page.request.post('/api/notes', { data: { path: '待办.md', content: '# 待办\n\n- [ ] 买牛奶\n- [ ] 交电费\n' } })
  expect(created.ok()).toBe(true)
  const note = (await created.json()) as { id: string }

  // 1. 设置 → 助手里添加供应商（保存后进入它的页面），测试连接，从列表添加两个模型
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: /^助手/ })).toContainText('未配置')
  await page.getByRole('link', { name: /^助手/ }).click()
  await expect(page).toHaveURL(/\/settings\/agent$/)
  await page.getByTestId('add-provider').click()
  await page.getByTestId('provider-name').fill('模拟 OpenAI')
  await page.getByTestId('provider-base-url').fill(mockBase)
  await page.getByTestId('provider-key').fill(MOCK_KEY)
  await page.getByTestId('provider-save').click()
  await expect(page).toHaveURL(/\/settings\/agent\/[^/]+$/)
  await expect(page.getByRole('heading', { name: '模拟 OpenAI', level: 1 })).toBeVisible()
  const card = page.getByTestId('provider-card')
  await expect(card).toContainText('模拟 OpenAI')
  await expect(card).toContainText('••••1234')
  await expect(page.locator('body')).not.toContainText(MOCK_KEY)

  await card.getByTestId('test-provider').click()
  await expect(card.getByTestId('test-result')).toContainText('找到 2 个模型')
  for (const id of ['mock-smart', 'mock-fast']) {
    await card.getByRole('button', { name: id, exact: true }).click()
    await expect(page.getByTestId('model-id')).toHaveValue(id)
    await page.getByTestId('model-context').fill('32000')
    await page.getByTestId('model-max-output').fill('4096')
    await page.getByTestId('model-save').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await expect(card.getByTestId('model-row')).toHaveCount(2)
  await shot(page, 'agent-provider')
  // 返回助手页：供应商行显示模型数，第一个添加的模型自动成为默认模型
  await page.getByRole('button', { name: '返回助手' }).click()
  await expect(page).toHaveURL(/\/settings\/agent$/)
  await expect(page.getByTestId('provider-row')).toContainText('2 个模型')
  await expect(page.getByTestId('default-model')).toContainText('mock-smart')
  await shot(page, 'agent-settings')

  // 2. 打开笔记，点标题栏的助手图标在弹窗里打开助手；当前笔记默认附上
  await page.goto(`/note/${encodeURIComponent(note.id)}`)
  await expect(page.locator('.cm-content')).toContainText('买牛奶')
  await page.locator('.editor-bar').getByRole('button', { name: '助手', exact: true }).click()
  const popup = page.getByTestId('agent-popup')
  await expect(popup).toBeVisible()
  const panel = popup.getByTestId('agent-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.mention-chip.is-context')).toContainText('待办')
  await expect(panel.getByTestId('model-select')).toContainText('mock-smart')

  // 3. 发送：流式回复逐字出现，随后是工具卡片
  await panel.getByTestId('agent-input').fill('帮我把买牛奶勾上')
  await panel.getByTestId('agent-send').click()
  await expect(panel.getByTestId('msg-user')).toContainText('帮我把买牛奶勾上')
  const draft = panel.getByTestId('msg-draft')
  await expect(draft).toContainText('好的')
  await expect(panel.getByTestId('agent-stop')).toBeVisible()
  await expect(draft).not.toContainText('确认清单的写法')
  await expect(panel.getByTestId('tool-card').first()).toContainText('读取笔记')

  // 4. 修改需要批准：差异里能看到改前改后
  const approval = panel.getByTestId('approval-card')
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(approval).toContainText('待办.md')
  await expect(approval.locator('.diff-line.is-del')).toContainText('- [ ] 买牛奶')
  await expect(approval.locator('.diff-line.is-add')).toContainText('- [x] 买牛奶')
  await shot(page, 'agent-approval')
  // 批准前文件没变
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toContain('- [ ] 买牛奶')
  await page.waitForTimeout(shotDir ? 1200 : 0)
  await approval.getByRole('button', { name: '批准' }).click()

  // 5. 写入后编辑器内容实时更新，助手给出最终回复
  // 实时预览把任务标记渲染成复选框：第一项变为已勾选，第二项不变
  const boxes = page.locator('.cm-content .cm-task-checkbox')
  await expect(boxes.nth(0)).toBeChecked()
  await expect(boxes.nth(1)).not.toBeChecked()
  await expect(panel.getByTestId('msg-assistant').last()).toContainText('已经改好了')
  await expect(panel.getByTestId('agent-send')).toBeVisible()
  await expect(panel.getByTestId('tool-card')).toHaveCount(2)
  await expect(panel.getByTestId('agent-usage')).toContainText('/ 32k')
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toContain('- [x] 买牛奶')

  // 6. 切换模型后，下一轮请求发给新模型
  await page.waitForTimeout(shotDir ? 1000 : 0)
  await panel.getByTestId('model-select').click()
  await page.getByRole('menuitemradio', { name: /mock-fast/ }).click()
  await expect(panel.getByTestId('model-select')).toContainText('mock-fast')
  await panel.getByTestId('agent-input').fill('换个模型说一句')
  await panel.getByTestId('agent-send').click()
  await expect(panel.getByTestId('msg-assistant').last()).toContainText('这是 mock-fast 的回复')
  expect(received.at(-1)?.model).toBe('mock-fast')
  await shot(page, 'agent-switch-model')
  expect(received.slice(0, 3).every((r) => r.model === 'mock-smart')).toBe(true)

  // 7. 弹窗里的“展开”：跳到整页助手，接着同一个对话（会话在全局 store 里，不新开）
  await popup.getByRole('button', { name: '展开到助手页' }).click()
  await expect(page).toHaveURL(/\/agent$/)
  await expect(popup).toHaveCount(0)
  await expect(page.getByTestId('agent-panel').getByTestId('msg-user')).toHaveCount(2)
  await expect(page.getByTestId('agent-panel').getByTestId('msg-assistant').last()).toContainText('这是 mock-fast 的回复')
  await page.goto(`/note/${encodeURIComponent(note.id)}`)
  await expect(page.locator('.cm-content')).toContainText('买牛奶')

  // 8. 刷新后对话仍在：弹窗不随刷新保留，重新打开后看到同一个对话
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('买牛奶')
  await expect(page.getByTestId('agent-popup')).toHaveCount(0)
  await page.locator('.editor-bar').getByRole('button', { name: '助手', exact: true }).click()
  await expect(page.getByTestId('agent-popup').getByTestId('agent-panel').getByTestId('msg-user')).toHaveCount(2)

  if (shotDir) {
    await page.waitForTimeout(800)
    const video = page.video()
    await page.close()
    if (video) {
      mkdirSync(resolve(shotDir, 'video'), { recursive: true })
      await video.saveAs(resolve(shotDir, 'video', 'agent-flow.webm'))
    }
  }
  info.annotations.push({ type: 'mock', description: mockBase })
})

test('手机上助手是全屏页面，可以返回', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto('/agent')
  const panel = page.getByTestId('agent-panel')
  await expect(panel).toBeVisible()
  // 新设备上没有打开的对话：从历史里打开上一个用例的对话
  await panel.getByRole('button', { name: '全部对话' }).click()
  await panel.locator('.chat-open', { hasText: '帮我把买牛奶勾上' }).click()
  await expect(panel.getByTestId('msg-user')).toHaveCount(2)
  await expect(panel.getByTestId('agent-input')).toBeVisible()
  await shot(page, 'agent-mobile')
  await panel.getByRole('button', { name: '返回' }).click()
  await expect(page).toHaveURL(/\/$/)
})

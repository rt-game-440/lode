// 阶段 4 实测：起一个独立的本地实例，用真实的 MCP 客户端（Claude Code）走一遍“搜索 → 读取 → 追加一行”，
// 同时在浏览器里打开这篇笔记，截图证明无需刷新就能看到修改。
//
// 用法（先运行 scripts/build.sh）：node web/scripts/mcp-live-check.mjs
// 环境变量：LIVE_PORT（默认 18788）、LIVE_MODEL（默认 haiku）。
// 输出：docs/screenshots/stage-4/4-4-*.png、docs/evidence/stage-4/live-*.txt。token 明文不写入任何文件或输出。
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..', '..')
const port = Number(process.env.LIVE_PORT ?? 18788)
const base = `http://127.0.0.1:${port}`
const dataDir = join(root, 'data-live4')
const shotDir = join(root, 'docs', 'screenshots', 'stage-4')
const evDir = join(root, 'docs', 'evidence', 'stage-4')
const bin = join(root, 'bin', process.platform === 'win32' ? 'lode.exe' : 'lode')
const model = process.env.LIVE_MODEL ?? 'haiku'
const LINE = '- 来自 Claude Code 的一行'

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(shotDir, { recursive: true })
mkdirSync(evDir, { recursive: true })

const log = (...a) => console.log('[live]', ...a)
let secret = ''
const redact = (s) => (secret ? String(s).replaceAll(secret, 'lode_<已隐去>') : String(s))

const server = spawn(bin, ['serve'], {
  env: { ...process.env, LODE_ADDR: `127.0.0.1:${port}`, LODE_DATA_DIR: dataDir, LODE_LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const browser = await chromium.launch()

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {}
    if (i > 100) throw new Error('服务没有启动')
    await new Promise((r) => setTimeout(r, 100))
  }

  // 浏览器上下文的 request 与页面共享 cookie：用它设置随机密码（只在这次实测里使用）并建数据
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
  const req = ctx.request
  const must = async (res) => {
    if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`)
    return res.status() === 204 ? null : res.json()
  }
  await must(await req.post(`${base}/api/auth/setup`, { data: { password: randomBytes(18).toString('base64url') } }))
  const note = await must(
    await req.post(`${base}/api/notes`, { data: { path: '实测/收件箱.md', content: '# 收件箱\n\n- 买牛奶\n- 回复邮件\n' } }),
  )
  const created = await must(await req.post(`${base}/api/tokens`, { data: { name: 'Claude Code', scope: 'write' } }))
  secret = created.secret

  const page = await ctx.newPage()
  await page.goto(`${base}/note/${note.id}`)
  await page.locator('.cm-content').getByText('回复邮件').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shotDir, '4-4-before-mcp.png') })
  log('已打开笔记并截图（修改前）')

  // 1. claude mcp add / list：用临时配置目录，不碰用户自己的 Claude Code 配置
  const cfgDir = join(dataDir, 'claude-config')
  mkdirSync(cfgDir, { recursive: true })
  const isolated = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }
  delete isolated.CLAUDECODE
  const add = spawnSync(
    'claude',
    ['mcp', 'add', '--transport', 'http', 'lode', `${base}/mcp`, '--header', `Authorization: Bearer ${secret}`],
    { cwd: dataDir, env: isolated, encoding: 'utf8' },
  )
  const list = spawnSync('claude', ['mcp', 'list'], { cwd: dataDir, env: isolated, encoding: 'utf8', timeout: 120_000 })
  const addLog = [
    `$ claude mcp add --transport http lode ${base}/mcp --header "Authorization: Bearer <token>"`,
    redact(add.stdout + add.stderr).trim(),
    '$ claude mcp list',
    redact(list.stdout + list.stderr).trim(),
  ].join('\n')
  writeFileSync(join(evDir, 'live-claude-mcp-add.txt'), `${addLog}\n`)
  log(addLog)
  rmSync(cfgDir, { recursive: true, force: true }) // 里面有 token 明文

  // 2. claude -p：用 --mcp-config 加载项目式配置，token 通过环境变量展开，不落盘
  const mcpConfig = join(dataDir, 'mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { lode: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer ${LODE_TOKEN}' } } } }, null, 2),
  )
  const env = { ...process.env, LODE_TOKEN: secret }
  delete env.CLAUDECODE // 允许在 Claude Code 会话里嵌套启动
  const prompt = [
    '请只用 lode 这个 MCP 服务器提供的工具完成下面三步：',
    '1. 用 search_notes 搜索“收件箱”；',
    '2. 用 read_note 读取搜到的那篇笔记，记下 rev；',
    `3. 用 update_note 的 append 模式，在这篇笔记末尾追加一行：${LINE}`,
    '完成后用一句话说明结果。',
  ].join('\n')
  const run = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__lode__search_notes',
      'mcp__lode__read_note',
      'mcp__lode__update_note',
      '--output-format',
      'json',
    ],
    { cwd: dataDir, env, encoding: 'utf8', timeout: 300_000 },
  )
  let summary = redact(run.stdout + run.stderr)
  try {
    const r = JSON.parse(run.stdout)
    summary = JSON.stringify({ is_error: r.is_error, num_turns: r.num_turns, duration_ms: r.duration_ms, result: redact(r.result) }, null, 2)
  } catch {}
  log('claude -p 结果：', summary)

  await page.locator('.cm-content').getByText(LINE.slice(2)).waitFor({ timeout: 30_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shotDir, '4-4-after-claude-code.png') })
  log('浏览器未刷新即看到追加的一行，已截图')

  const audit = await must(await req.get(`${base}/api/audit?limit=20`))
  const rows = audit.entries
    .reverse()
    .map((e) => `${new Date(e.at).toISOString()}  ${e.token_name}  ${e.tool}  ${e.target}  ${e.ok ? '成功' : `失败：${e.error}`}`)
  const changes = await must(await req.get(`${base}/api/changes?since=0`))
  const changeRows = changes.changes.map((c) => `seq ${c.seq}  ${c.type}  ${c.path}  rev ${c.rev}  设备：${c.device_name}`)
  const content = (await must(await req.get(`${base}/api/notes/${note.id}`))).content
  writeFileSync(
    join(evDir, 'live-claude-code.txt'),
    [
      `# ${new Date().toISOString()} Claude Code（${model}）经 MCP 搜索 → 读取 → 追加`,
      '',
      '## claude -p 输出',
      summary,
      '',
      '## 调用记录（/api/audit）',
      ...rows,
      '',
      '## 变更事件（/api/changes）',
      ...changeRows,
      '',
      '## 笔记最终内容',
      content,
    ].join('\n'),
  )
  if (!content.includes(LINE)) throw new Error('笔记里没有追加的那一行')
  log('完成，证据写入 docs/evidence/stage-4/')
} finally {
  await browser.close()
  server.kill()
}

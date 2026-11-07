import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// 冒烟测试直接启动构建好的单二进制（先运行 scripts/build），每次使用全新的数据目录。
const root = resolve(import.meta.dirname, '..')
const bin = process.env.LODE_BIN ?? join(root, 'bin', process.platform === 'win32' ? 'lode.exe' : 'lode')
export const dataDir = resolve(import.meta.dirname, '.e2e-data')
const port = Number(process.env.LODE_E2E_PORT ?? 18787)

// 配置文件也会在 worker 进程里加载，那时服务已经在用这个目录，只在主进程清理
if (!process.env.TEST_WORKER_INDEX && !process.env.LODE_E2E_KEEP) rmSync(dataDir, { recursive: true, force: true })

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `"${bin}" serve`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { LODE_ADDR: `127.0.0.1:${port}`, LODE_DATA_DIR: dataDir, LODE_LOG_LEVEL: 'warn' },
  },
})

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('deviceId', () => {
  // 手机通过 http://192.168.x.x 访问时页面不是安全上下文，浏览器不提供 crypto.randomUUID
  it('非安全上下文（没有 randomUUID）也能生成 16 位十六进制设备 ID', async () => {
    const realCrypto = (await import('node:crypto')).webcrypto
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array<ArrayBuffer>) => realCrypto.getRandomValues(a) })
    const { deviceId } = await import('./device')
    const id = deviceId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(deviceId()).toBe(id)
  })
})

import { describe, expect, it } from 'vitest'
import { b64urlToBytes, bytesToB64url, creationOptions, isIpHost, passkeyAvailable, requestOptions } from './webauthn'

describe('base64url', () => {
  it('与字节互逆，不带填充，用 - 和 _', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1, 2, 3])
    const s = bytesToB64url(bytes)
    expect(s).toBe('-__-AAECAw')
    expect([...b64urlToBytes(s)]).toEqual([...bytes])
    expect(bytesToB64url(new Uint8Array([]))).toBe('')
    expect(b64urlToBytes('').length).toBe(0)
  })
})

describe('通行密钥是否可用', () => {
  const ok = { isSecureContext: true, hasApi: true, hostname: 'notes.example.com' }
  it('HTTPS 域名和 localhost 可用', () => {
    expect(passkeyAvailable(ok)).toBe(true)
    expect(passkeyAvailable({ ...ok, hostname: 'localhost' })).toBe(true)
  })
  it('非安全上下文（http://局域网 IP）不可用', () => {
    expect(passkeyAvailable({ ...ok, isSecureContext: false, hostname: '192.168.1.10' })).toBe(false)
    expect(passkeyAvailable({ ...ok, isSecureContext: false })).toBe(false)
  })
  it('IP 地址不能作 RP ID，即使浏览器认为它是安全上下文（127.0.0.1、::1）', () => {
    for (const h of ['127.0.0.1', '10.0.0.2', '::1', '[::1]', '2001:db8::1']) {
      expect(isIpHost(h)).toBe(true)
      expect(passkeyAvailable({ ...ok, hostname: h })).toBe(false)
    }
    expect(isIpHost('localhost')).toBe(false)
    expect(isIpHost('nas.local')).toBe(false)
  })
  it('浏览器不支持 WebAuthn 时不可用', () => {
    expect(passkeyAvailable({ ...ok, hasApi: false })).toBe(false)
  })
})

describe('选项转换', () => {
  it('登记选项：challenge、user.id 和排除列表的 id 转成字节', () => {
    const out = creationOptions({
      publicKey: {
        challenge: 'AQID',
        rp: { id: 'localhost', name: 'Lode' },
        user: { id: 'BAUG', name: 'lode', displayName: 'Lode' },
        excludeCredentials: [{ id: 'Bwg', type: 'public-key' }],
        authenticatorSelection: { residentKey: 'required' },
      },
    }).publicKey!
    expect([...(out.challenge as Uint8Array)]).toEqual([1, 2, 3])
    expect([...(out.user.id as Uint8Array)]).toEqual([4, 5, 6])
    expect([...(out.excludeCredentials![0]!.id as Uint8Array)]).toEqual([7, 8])
    expect(out.authenticatorSelection).toEqual({ residentKey: 'required' })
    expect(out.rp.id).toBe('localhost')
  })

  it('登录选项：没有 allowCredentials 时保持为空（可发现凭据）', () => {
    const out = requestOptions({ publicKey: { challenge: 'AQID', rpId: 'localhost', userVerification: 'required' } }).publicKey!
    expect([...(out.challenge as Uint8Array)]).toEqual([1, 2, 3])
    expect(out.allowCredentials).toBeUndefined()
    expect(out.rpId).toBe('localhost')
  })
})

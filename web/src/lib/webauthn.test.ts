import { describe, expect, it } from 'vitest'
import {
  b64urlToBytes,
  bytesToB64url,
  creationOptions,
  extensionInputs,
  extensionOutputs,
  isIpHost,
  passkeyAvailable,
  requestOptions,
} from './webauthn'

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

describe('PRF 扩展', () => {
  it('登记时只探测（prf: {}）原样保留，其他扩展不受影响', () => {
    const out = creationOptions({
      publicKey: { challenge: 'AQID', rp: { id: 'localhost' }, user: { id: 'BAUG' }, extensions: { prf: {}, credProps: true } },
    }).publicKey!
    expect(out.extensions).toEqual({ prf: {}, credProps: true })
    expect(extensionInputs(undefined)).toBeUndefined()
  })

  it('验证选项里的盐（eval、evalByCredential）转成字节', () => {
    const out = requestOptions({
      publicKey: {
        challenge: 'AQID',
        allowCredentials: [{ id: 'Bwg', type: 'public-key' }],
        extensions: { prf: { eval: { first: 'CQkJ' }, evalByCredential: { Bwg: { first: 'AQ', second: 'Ag' } } } },
      },
    }).publicKey!
    const prf = (out.extensions as any).prf
    expect([...prf.eval.first]).toEqual([9, 9, 9])
    expect(prf.eval.second).toBeUndefined()
    expect([...prf.evalByCredential.Bwg.first]).toEqual([1])
    expect([...prf.evalByCredential.Bwg.second]).toEqual([2])
  })

  it('结果里的 ArrayBuffer 转成 base64url，enabled 和其他扩展结果原样带上', () => {
    const first = new Uint8Array(32).fill(7)
    const res = extensionOutputs({ credProps: { rk: true }, prf: { enabled: true, results: { first: first.buffer } } } as any)
    expect(res).toEqual({ credProps: { rk: true }, prf: { enabled: true, results: { first: bytesToB64url(first) } } })
    // 视图（Uint8Array 的一段）也按实际范围编码
    const view = new Uint8Array([0, 1, 2, 3]).subarray(1, 3)
    expect(extensionOutputs({ prf: { results: { first: view } } } as any)).toEqual({ prf: { results: { first: bytesToB64url(new Uint8Array([1, 2])) } } })
    expect(extensionOutputs({ prf: { enabled: false } } as any)).toEqual({ prf: { enabled: false } })
    expect(extensionOutputs({})).toEqual({})
    // 直接 JSON 序列化 ArrayBuffer 会丢掉内容，所以必须转换
    expect(JSON.stringify(res)).toContain(bytesToB64url(first))
  })
})

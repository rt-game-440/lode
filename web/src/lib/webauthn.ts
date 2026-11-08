/**
 * 通行密钥（WebAuthn）的浏览器端封装：
 * 服务端按 go-webauthn 的 JSON 格式给出选项（二进制字段是 base64url），这里转成 navigator.credentials
 * 需要的 ArrayBuffer，调用后再把结果转回服务端期望的 JSON。
 *
 * 之后加 PRF 扩展（issue #29）：选项里的 extensions.prf 原样传给浏览器，结果在
 * credential.getClientExtensionResults() 里，这里的 toJSON 已经把 clientExtensionResults 一并带上。
 */

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let bin = ''
  for (const c of u) bin += String.fromCharCode(c)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** 主机名是 IP 地址时不能用作 RP ID（通行密钥绑定域名）。 */
export function isIpHost(hostname: string): boolean {
  return IPV4.test(hostname) || hostname.includes(':') || hostname.startsWith('[')
}

/**
 * 当前页面能否使用通行密钥：安全上下文（HTTPS 或 localhost）、浏览器支持 WebAuthn、且不是通过 IP 地址访问。
 * 不满足时界面上不显示任何通行密钥选项。
 */
export function passkeyAvailable(env: { isSecureContext?: boolean; hostname?: string; hasApi?: boolean } = defaultEnv()): boolean {
  return Boolean(env.isSecureContext && env.hasApi && env.hostname && !isIpHost(env.hostname))
}

function defaultEnv() {
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    hasApi: typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials,
    hostname: typeof location !== 'undefined' ? location.hostname : '',
  }
}

interface JsonDescriptor {
  id: string
  type: PublicKeyCredentialType
  transports?: AuthenticatorTransport[]
}

function descriptors(list: JsonDescriptor[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({ ...d, id: b64urlToBytes(d.id) }))
}

/** 服务端返回的 {publicKey: {...}}（登记）。 */
export function creationOptions(json: { publicKey: Record<string, any> }): CredentialCreationOptions {
  const pk = json.publicKey
  return {
    publicKey: {
      ...pk,
      challenge: b64urlToBytes(pk.challenge),
      user: { ...pk.user, id: b64urlToBytes(pk.user.id) },
      excludeCredentials: descriptors(pk.excludeCredentials),
    } as unknown as PublicKeyCredentialCreationOptions,
  }
}

/** 服务端返回的 {publicKey: {...}}（登录）。 */
export function requestOptions(json: { publicKey: Record<string, any> }): CredentialRequestOptions {
  const pk = json.publicKey
  return {
    publicKey: {
      ...pk,
      challenge: b64urlToBytes(pk.challenge),
      allowCredentials: descriptors(pk.allowCredentials),
    } as unknown as PublicKeyCredentialRequestOptions,
  }
}

/** 用户取消、超时、或认证器拒绝时浏览器抛出 NotAllowedError。 */
export function isCancelled(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
}

export async function createPasskey(json: { publicKey: Record<string, any> }): Promise<unknown> {
  const cred = (await navigator.credentials.create(creationOptions(json))) as PublicKeyCredential | null
  if (!cred) throw new DOMException('未创建凭据', 'NotAllowedError')
  const r = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      attestationObject: bytesToB64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  }
}

export async function getPasskey(json: { publicKey: Record<string, any> }): Promise<unknown> {
  const cred = (await navigator.credentials.get(requestOptions(json))) as PublicKeyCredential | null
  if (!cred) throw new DOMException('未取得凭据', 'NotAllowedError')
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      authenticatorData: bytesToB64url(r.authenticatorData),
      signature: bytesToB64url(r.signature),
      userHandle: r.userHandle ? bytesToB64url(r.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  }
}

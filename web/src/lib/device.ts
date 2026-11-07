// 设备标识：首次启动时生成并存在 localStorage；设备名默认从 UA 推断。

const ID_KEY = 'lode.deviceId'
const NAME_KEY = 'lode.deviceName'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

let cachedId: string | null = null

export function deviceId(): string {
  if (cachedId) return cachedId
  const s = storage()
  let id = s?.getItem(ID_KEY) ?? null
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    s?.setItem(ID_KEY, id)
  }
  cachedId = id
  return id
}

export function guessDeviceName(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '浏览器'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '设备'
  return `${os} ${browser}`
}

export function deviceName(): string {
  const saved = storage()?.getItem(NAME_KEY)
  if (saved) return saved
  return guessDeviceName(globalThis.navigator?.userAgent ?? '')
}

export function setDeviceName(name: string) {
  const s = storage()
  if (!s) return
  if (name.trim()) s.setItem(NAME_KEY, name.trim())
  else s.removeItem(NAME_KEY)
}

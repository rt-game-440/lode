/** 与服务端 workspace.cleanName 一致：去掉首尾空白后不能为空、不超过 64 个字符、不含控制字符。 */
export function invalidWorkspaceName(name: string): string | null {
  const v = name.trim()
  if (!v) return '请输入名称'
  const chars = [...v]
  if (chars.length > 64) return '名称不能超过 64 个字符'
  // Unicode 的 Cc 类：U+0000–001F、U+007F–009F（与 Go 的 unicode.IsControl 相同）
  const control = (ch: string) => {
    const c = ch.codePointAt(0) ?? 0
    return c < 0x20 || (c >= 0x7f && c <= 0x9f)
  }
  if (chars.some(control)) return '名称不能包含控制字符'
  return null
}

/** 看起来是绝对路径：Unix 的 /…、Windows 的 C:\… 或 C:/…、UNC 路径。真正的校验在服务器（路径在服务器上）。 */
export function looksAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p.trim())
}

// 处理 vault 相对路径（"/" 分隔）。

export function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}

/** 笔记标题：文件名去掉 .md。 */
export function noteTitle(p: string): string {
  return basename(p).replace(/\.md$/i, '')
}

/** 去掉 .md 的路径。 */
export function stripMd(p: string): string {
  return p.replace(/\.md$/i, '')
}

/** 用户输入的名称是否合法（不含路径分隔符和 Obsidian 不支持的字符）。 */
export function invalidNameReason(name: string): string | null {
  const n = name.trim()
  if (!n) return '名称不能为空'
  if (n.startsWith('.')) return '名称不能以 . 开头'
  if (/[\\/:*?"<>|#^[\]]/.test(n)) return '名称不能包含 \\ / : * ? " < > | # ^ [ ]'
  return null
}

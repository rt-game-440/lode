/**
 * 笔记浏览位置记忆（#71）：记下每篇笔记上次看到的位置，再次打开时回到那里。
 *
 * 存在本机 localStorage，按工作空间分开（键名 `lode.readpos[:<ws>]`），只保留最近写入的 MAX_POSITIONS 篇，
 * 不写进笔记文件、不跨设备同步。位置按文档字符偏移记录（topPos + offset），而不是只记像素：
 * CodeMirror 按需渲染，未渲染部分的高度是估算值，按文档位置落点才准。
 * 从助手页返回同一篇笔记（`rememberNoteScroll`）也走这套存储。
 */
import { WORKSPACE_STORAGE, storageKey } from './workspace'

export const MAX_POSITIONS = 200

export interface ReadPos {
  /** 视口顶端所在行的起点（文档字符偏移） */
  topPos: number
  /** 视口顶端相对该行顶部的像素偏移 */
  offset: number
  /** 光标（选区 head）的文档偏移 */
  head: number
}

type Entry = [id: string, pos: ReadPos]

const keyFor = (ws: string) => storageKey(WORKSPACE_STORAGE.readPos, ws)

function load(ws: string): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(ws)) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is Entry =>
        Array.isArray(e) &&
        typeof e[0] === 'string' &&
        !!e[1] &&
        Number.isFinite(e[1].topPos) &&
        Number.isFinite(e[1].offset) &&
        Number.isFinite(e[1].head),
    )
  } catch {
    return []
  }
}

export function getReadPosition(ws: string, id: string): ReadPos | null {
  return load(ws).find((e) => e[0] === id)?.[1] ?? null
}

/** 写入一篇笔记的位置；放到最前面，超过上限时淘汰最早写入的。 */
export function saveReadPosition(ws: string, id: string, pos: ReadPos, max = MAX_POSITIONS) {
  const list = [[id, pos] as Entry, ...load(ws).filter((e) => e[0] !== id)].slice(0, max)
  try {
    localStorage.setItem(keyFor(ws), JSON.stringify(list))
  } catch {
    // 存储满或被禁用：记忆是尽力而为的，忽略
  }
}

// ---- 打开方式：带明确目标位置的入口不恢复 ----

let skipFor: string | null = null

/** 下一次打开这篇笔记时以目标位置为准（带位置的入口调用），不恢复记忆。 */
export function skipReadPositionOnce(id: string) {
  skipFor = id
}

export function takeSkipReadPosition(id: string): boolean {
  if (skipFor !== id) return false
  skipFor = null
  return true
}

// ---- 编辑器登记的“立即保存”入口 ----

let flusher: (() => void) | null = null

export function registerReadPositionFlusher(fn: (() => void) | null) {
  flusher = fn
}

/** 进入助手页前调用：把当前笔记的位置立即写入，从助手页返回时和其他打开方式一样恢复。 */
export function rememberNoteScroll(_id?: string) {
  flusher?.()
}

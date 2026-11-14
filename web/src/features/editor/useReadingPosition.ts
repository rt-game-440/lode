import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { type ReadPos, getReadPosition, registerReadPositionFlusher, saveReadPosition, takeSkipReadPosition } from '../../lib/scrollMemory'
import { currentWorkspace } from '../../lib/workspace'

const SAVE_DELAY = 250
/** 恢复后继续校正的时间点（毫秒）：CodeMirror 按需渲染会让估算高度逐步变准 */
const SETTLE_AT = [0, 60, 200, 450]

/**
 * 记录并恢复笔记的浏览位置（滚动 + 光标，#71）。
 * `restore(id)` 在编辑器载入这篇笔记的内容后调用；校正期间（到用户第一次手动操作或校正结束）不记录，
 * 避免把恢复过程中的中间位置写进去。切换笔记前要先 `flush()` 上一篇。
 */
export function useReadingPosition(scrollRef: RefObject<HTMLElement | null>, viewRef: RefObject<EditorView | null>) {
  /** 正在记录的笔记；null 表示还在恢复或没有笔记 */
  const live = useRef<{ id: string; ws: string } | null>(null)
  /** 最近一次编辑器可见时量到的位置：载入下一篇期间编辑器被隐藏、滚动被夹到 0，那时不能再量 */
  const last = useRef<{ id: string; ws: string; pos: ReadPos } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settle = useRef<{ cancel: () => void } | null>(null)

  const capture = () => {
    const l = live.current
    const view = viewRef.current
    const el = scrollRef.current
    if (!l || !view || !el || !el.isConnected || view.dom.getClientRects().length === 0) return
    const y = el.getBoundingClientRect().top - view.documentTop
    const block = view.lineBlockAtHeight(Math.max(0, y))
    last.current = {
      ...l,
      pos: { topPos: block.from, offset: Math.max(0, Math.round(y - block.top)), head: view.state.selection.main.head },
    }
  }
  /** 写入最近量到的位置（不重新测量） */
  const write = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const l = last.current
    if (l) saveReadPosition(l.ws, l.id, l.pos)
  }
  const api = useRef({ capture, write })
  api.current = { capture, write }

  useLayoutEffect(() => {
    const el = scrollRef.current
    const schedule = () => {
      if (!live.current) return
      api.current.capture()
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => api.current.write(), SAVE_DELAY)
    }
    const flush = () => {
      api.current.capture()
      api.current.write()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    el?.addEventListener('scroll', schedule, { passive: true })
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    registerReadPositionFlusher(flush)
    return () => {
      el?.removeEventListener('scroll', schedule)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
      registerReadPositionFlusher(null)
      settle.current?.cancel()
      flush()
      live.current = null
    }
  }, [scrollRef])

  /** 编辑器刚载入 id 的内容，恢复这一篇的位置。 */
  const restore = (id: string) => {
    settle.current?.cancel()
    live.current = null
    last.current = null
    const view = viewRef.current
    const el = scrollRef.current
    if (!view || !el) return
    const ws = currentWorkspace()
    const pos = takeSkipReadPosition(id) ? null : getReadPosition(ws, id)
    if (!pos) {
      el.scrollTo({ top: 0 })
      live.current = { id, ws }
      return
    }
    const len = view.state.doc.length
    // 笔记被外部大幅修改后记录的位置可能超出文档：退到文末
    const topPos = Math.min(pos.topPos, len)
    const head = Math.min(pos.head, len)
    // 只设光标，不聚焦、不滚动：手机上不弹出键盘
    view.dispatch({ selection: EditorSelection.cursor(head) })
    const place = () => {
      const block = view.lineBlockAt(topPos)
      const rect = el.getBoundingClientRect()
      el.scrollTop = view.documentTop - rect.top + el.scrollTop + block.top + pos.offset
    }
    place()
    const timers: ReturnType<typeof setTimeout>[] = []
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
    const stop = () => {
      timers.forEach(clearTimeout)
      events.forEach((e) => document.removeEventListener(e, finish, true))
      settle.current = null
    }
    const finish = () => {
      stop()
      live.current = { id, ws }
    }
    SETTLE_AT.forEach((ms, i) =>
      timers.push(
        setTimeout(() => {
          place()
          if (i === SETTLE_AT.length - 1) finish()
        }, ms),
      ),
    )
    // 用户任何滚动 / 点击 / 按键（包括点大纲跳转）都不再校正，开始记录
    events.forEach((e) => document.addEventListener(e, finish, { capture: true, passive: true, once: true }))
    settle.current = { cancel: stop }
  }

  return { restore, flush: () => api.current.write() }
}

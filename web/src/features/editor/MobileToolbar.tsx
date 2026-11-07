import { startCompletion } from '@codemirror/autocomplete'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Brackets, Hash, Image as ImageIcon, KeyboardOff, Link, List, ListTodo } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { onViewportChange } from '../../lib/viewport'
import { fadeTransition, springSheet } from '../../styles/tokens/motion'
import { insertImages } from './cm/extras'
import { cycleHeading, insertLink, insertWikiLink, toggleList } from './cm/format'

interface Props {
  view: EditorView | null
  upload: (file: File) => Promise<string>
  onUploadError: (err: unknown) => void
}

/**
 * 手机编辑工具栏：编辑器获得焦点（软键盘弹出）时贴在可视区域底部，提供常用 Markdown 插入。
 * 按钮在 pointerdown 时阻止默认行为，点按不会让编辑器失焦、键盘不会收起。
 */
export function MobileToolbar({ view, upload, onUploadError }: Props) {
  const [focused, setFocused] = useState(false)
  const [picking, setPicking] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (!view) return
    const sync = () => setFocused(view.hasFocus)
    view.dom.addEventListener('focusin', sync)
    view.dom.addEventListener('focusout', sync)
    sync()
    // 键盘弹出或收起后可视区域变化：把光标重新滚到可见处
    const off = onViewportChange(() => {
      if (!view.hasFocus) return
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) })
    })
    return () => {
      view.dom.removeEventListener('focusin', sync)
      view.dom.removeEventListener('focusout', sync)
      off()
    }
  }, [view])

  // 取消选择文件（React 没有 onCancel 类型）
  useEffect(() => {
    const el = fileRef.current
    if (!el) return
    const cancel = () => setPicking(false)
    el.addEventListener('cancel', cancel)
    return () => el.removeEventListener('cancel', cancel)
  }, [view])

  if (!view) return null
  const run = (cmd: (s: EditorState) => TransactionSpec, after?: () => void) => () => {
    view.dispatch(cmd(view.state))
    view.focus()
    after?.()
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="toolbar-image-input"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          setPicking(false)
          view.focus()
          void insertImages(view, files, upload, onUploadError)
        }}
      />
      <AnimatePresence>
        {(focused || picking) && (
          <motion.div
            className="mobile-toolbar"
            role="toolbar"
            aria-label="插入 Markdown"
            data-testid="mobile-toolbar"
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : { y: '100%' }}
            transition={reduced ? fadeTransition : springSheet}
          >
            <ToolButton label="标题" onPress={run(cycleHeading)}>
              <Hash size={20} />
            </ToolButton>
            <ToolButton label="列表" onPress={run((s) => toggleList(s, 'bullet'))}>
              <List size={20} />
            </ToolButton>
            <ToolButton label="任务" onPress={run((s) => toggleList(s, 'task'))}>
              <ListTodo size={20} />
            </ToolButton>
            <ToolButton label="链接" onPress={run(insertLink)}>
              <Link size={20} />
            </ToolButton>
            <ToolButton label="笔记链接" onPress={run(insertWikiLink, () => startCompletion(view))}>
              <Brackets size={20} />
            </ToolButton>
            <ToolButton
              label="图片"
              onPress={() => {
                setPicking(true)
                fileRef.current?.click()
              }}
            >
              <ImageIcon size={20} />
            </ToolButton>
            <span className="spacer" />
            <ToolButton label="收起键盘" onPress={() => view.contentDOM.blur()}>
              <KeyboardOff size={20} />
            </ToolButton>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function ToolButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="mobile-toolbar-btn"
      aria-label={label}
      title={label}
      // 不抢编辑器焦点，键盘保持弹出
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

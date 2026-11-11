// 把系统里的文件 / 文件夹拖进窗口即导入并打开。监听挂在 window 的捕获阶段：
// 早于 React 根和 CodeMirror，才能拦下编辑器对文本文件的默认“插入文件内容”。
// 只含图片的拖拽不接管，仍由编辑器上传成附件（features/editor/cm/extras.ts）。
import { AnimatePresence, motion } from 'motion/react'
import { Upload } from 'lucide-react'
import { useEffect } from 'react'
import { create } from 'zustand'
import { dirname } from '../../lib/paths'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../../api/client'
import { fadeTransition } from '../../styles/tokens/motion'
import { collectEntries, hasFiles, hasImportableDrop, looksImportable, topEntries } from './dropped'
import { runImportFlow } from './flow'

const useDropState = create<{ active: boolean; dir: string }>(() => ({ active: false, dir: '' }))
const clear = () => useDropState.setState({ active: false })

/** 落点所在目录：文件夹行 → 该文件夹，笔记行 → 它所在文件夹，其他 → 根。 */
function targetDir(t: EventTarget | null): string {
  const row = (t as Element | null)?.closest?.('[role="treeitem"]')
  const p = row?.getAttribute('data-path')
  if (!row || !p) return ''
  return row.hasAttribute('aria-expanded') ? p : dirname(p)
}

export function useDropImport() {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!looksImportable(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      const dir = targetDir(e.target)
      const s = useDropState.getState()
      if (!s.active || s.dir !== dir) useDropState.setState({ active: true, dir })
    }
    const leave = (e: DragEvent) => {
      // 在窗口内跨元素移动时 relatedTarget 不为空；离开窗口才为 null
      if (!e.relatedTarget) clear()
    }
    const drop = (e: DragEvent) => {
      const dt = e.dataTransfer
      if (!dt || !hasFiles(dt)) return
      // 必须在事件里同步取条目，之后 dt 就失效了
      const { entries, files } = topEntries(dt)
      clear()
      if (!hasImportableDrop(entries, files)) return
      e.preventDefault()
      e.stopPropagation()
      const dir = targetDir(e.target)
      collectEntries(entries, files)
        .then((list) => runImportFlow(list, dir, { open: true }))
        .catch((err) => useUI.getState().toast({ message: errorMessage(err), tone: 'error' }))
    }
    // 冒泡阶段兜底：没人处理的文件拖放（如图片落在编辑器外）不允许放下，避免浏览器直接打开文件、离开应用
    const guardOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const guardDrop = (e: DragEvent) => {
      if (!e.defaultPrevented && hasFiles(e.dataTransfer)) e.preventDefault()
    }
    window.addEventListener('dragenter', over, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('dragover', guardOver)
    window.addEventListener('drop', guardDrop)
    return () => {
      window.removeEventListener('dragenter', over, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('dragover', guardOver)
      window.removeEventListener('drop', guardDrop)
    }
  }, [])
}

/** 拖拽期间的全窗提示：虚线描边 + 目标目录。不拦截指针，不影响落点判断。 */
export function DropOverlay() {
  const { active, dir } = useDropState()
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="drop-overlay"
          data-testid="drop-overlay"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeTransition}
        >
          <div className="drop-overlay-tip">
            <Upload size={18} />
            松开以导入到「{dir || '根目录'}」
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// 导入流程：规划 → 导入 → 汇报，可选打开导入的第一篇。选择器和拖放共用。
import { currentWorkspace } from '../../lib/workspace'
import { useUI } from '../../stores/ui'
import { openNote } from '../actions'
import { type ImportEntry, buildImportPlan } from './plan'
import { importNotes, reportImport } from './runImport'

let running = false

export async function runImportFlow(
  entries: (ImportEntry & { file: File })[],
  dir: string,
  opts: { open?: boolean } = {},
): Promise<void> {
  const ui = useUI.getState()
  if (running) {
    ui.toast({ message: '正在导入，请稍候' })
    return
  }
  const plan = buildImportPlan(entries, dir)
  if (!plan.items.length) {
    ui.toast({ message: '没有可导入的 Markdown 或文本文件', tone: 'error' })
    return
  }
  running = true
  const ws = currentWorkspace()
  ui.toast({ message: `正在导入 ${plan.items.length} 篇…`, persistent: true })
  try {
    const result = await importNotes(plan.items, plan.skipped)
    // 清掉“正在导入”的提示，再显示结果
    useUI.setState((s) => ({ toasts: s.toasts.filter((t) => !t.message.startsWith('正在导入 ')) }))
    reportImport(result)
    // 导入期间切走了工作空间就不要跳到别的空间的笔记
    if (opts.open && result.created.length && currentWorkspace() === ws) {
      const first = result.created.reduce((a, b) => (b.index < a.index ? b : a))
      openNote(first.id)
    }
  } finally {
    running = false
  }
}

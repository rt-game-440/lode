// 导入执行：读文件、逐篇创建（自动改名）、汇总结果。
import { ApiError, api, errorMessage } from '../../api/client'
import { confirmDialog } from '../../components/overlays'
import { currentWorkspace } from '../../lib/workspace'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { type ImportItem, type ImportSkip, decodeText } from './plan'

export interface ImportResult {
  ok: number
  failed: ImportSkip[]
  skipped: ImportSkip[]
  /** 导入中途切换了工作空间，剩余文件未导入 */
  aborted: boolean
  /** 成功创建的笔记；index 是它在导入计划里的序号 */
  created: { index: number; id: string }[]
}

const CONCURRENCY = 3

export async function importNotes(
  items: ImportItem<File>[],
  skipped: ImportSkip[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const ws = currentWorkspace()
  const failed: ImportSkip[] = []
  let ok = 0
  let done = 0
  let next = 0
  let aborted = false
  const created: ImportResult['created'] = []

  const worker = async () => {
    while (next < items.length) {
      if (currentWorkspace() !== ws) {
        aborted = true
        return
      }
      const index = next++
      const it = items[index]
      try {
        const content = decodeText(await it.file.arrayBuffer())
        const n = await api.createNote(it.path, content, true)
        created.push({ index, id: n.id })
        ok++
      } catch (err) {
        failed.push({ name: it.path, reason: errorMessage(err) })
        // 网络不可用时继续尝试没有意义
        if (err instanceof ApiError && err.code === 'network') next = items.length
      }
      onProgress?.(++done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))

  if (ok && currentWorkspace() === ws) await useVault.getState().load()
  return { ok, failed, skipped, aborted, created }
}

export function reportImport(r: ImportResult) {
  const parts = [`已导入 ${r.ok} 篇`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 个`)
  if (r.failed.length) parts.push(`失败 ${r.failed.length} 个`)
  if (r.aborted) parts.push('已因切换工作空间中止')
  const bad = r.failed.length > 0 || r.aborted
  useUI.getState().toast({
    message: parts.join('，'),
    tone: bad ? 'error' : 'success',
    persistent: bad || r.skipped.length > 0,
    action:
      r.failed.length || r.skipped.length
        ? { label: '查看详情', run: () => void showDetails(r) }
        : undefined,
  })
}

async function showDetails(r: ImportResult) {
  const rows = [...r.failed.map((x) => ({ ...x, kind: '失败' })), ...r.skipped.map((x) => ({ ...x, kind: '跳过' }))]
  await confirmDialog({
    title: '导入详情',
    confirmLabel: '知道了',
    message: (
      <ul className="import-details">
        {rows.slice(0, 200).map((x, i) => (
          <li key={i}>
            {x.kind}：{x.name}（{x.reason}）
          </li>
        ))}
        {rows.length > 200 && <li>……另有 {rows.length - 200} 项</li>}
      </ul>
    ),
  })
}

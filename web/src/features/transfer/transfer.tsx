// 在工作空间之间移动、复制笔记和文件夹（#72）：右键菜单入口、目标选择对话框、拖到工作空间切换器。
import { Copy, FolderInput } from 'lucide-react'
import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, api, errorMessage, workspaceApi } from '../../api/client'
import type { TransferItem, TransferResult, WorkspaceInfo } from '../../api/types'
import { type MenuEntry, confirmDialog, customDialog } from '../../components/overlays'
import { Button, Spinner } from '../../components/ui'
import { editorBridge, useEditor } from '../../stores/editor'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { useWorkspace, workspaceName } from '../../stores/workspace'
import { sync, useSync } from '../../sync/engine'
import { affectedNotes, brokenLinksWarning, describeItems, renameLabel, resultMessage } from './items'
import './transfer.css'

export type TransferMode = 'move' | 'copy'

const OFFLINE_HINT = '需要联网'

/** 有不止一个工作空间时才提供跨空间移动、复制。 */
export function canTransfer(): boolean {
  return useWorkspace.getState().list.length > 1
}

function offline(): boolean {
  return useSync.getState().status === 'offline'
}

/**
 * 文件树右键菜单里的两项。只有一个工作空间时返回空；离线时显示但不能点，提示需要联网。
 */
export function transferMenuEntries(items: TransferItem[]): MenuEntry[] {
  if (!items.length || !canTransfer()) return []
  const off = offline()
  return [
    'separator',
    {
      label: '移动到工作空间…',
      icon: <FolderInput size={16} />,
      disabled: off,
      hint: off ? OFFLINE_HINT : undefined,
      run: () => void transferWithDialog(items, 'move'),
    },
    {
      label: '复制到工作空间…',
      icon: <Copy size={16} />,
      disabled: off,
      hint: off ? OFFLINE_HINT : undefined,
      run: () => void transferWithDialog(items, 'copy'),
    },
  ]
}

/** 把编辑器里没保存的修改交给服务器；还有没同步的修改时返回提示，否则返回 null。 */
async function settle(): Promise<string | null> {
  if (offline()) return '需要联网才能在工作空间之间移动或复制'
  await editorBridge.current?.flush().catch(() => {})
  await sync.drain().catch(() => {})
  if (offline()) return '需要联网才能在工作空间之间移动或复制'
  if (useSync.getState().pending > 0) return '还有修改没有同步到服务器，同步完成后再试'
  return null
}

/** 右键菜单入口：选择目标工作空间和文件夹，确认后执行。 */
export async function transferWithDialog(items: TransferItem[], mode: TransferMode) {
  const res = await customDialog<TransferResult | null>((done) => <TransferForm items={items} mode={mode} done={done} />)
  if (res) await finish(items, res)
}

/** 拖到工作空间切换器上：移动（按住 Alt 为复制）到目标工作空间的根目录。移动且有会失效的链接时先确认。 */
export async function transferByDrop(items: TransferItem[], target: string, mode: TransferMode) {
  const ui = useUI.getState()
  if (!items.length || target === useWorkspace.getState().current) return
  const problem = await settle()
  if (problem) return ui.toast({ message: problem, tone: 'error' })
  const req = { items, target_workspace: target, target_dir: '', mode }
  try {
    if (mode === 'move') {
      const plan = await api.transfer({ ...req, dry_run: true })
      if (plan.broken_links > 0) {
        const name = workspaceName(useWorkspace.getState().list, target)
        const ok = await confirmDialog({
          title: `把${describeItems(items, useVault.getState().notes)}移动到“${name}”？`,
          message: `${brokenLinksWarning(plan.broken_links)}原来的笔记会移到回收站，可以恢复。`,
          confirmLabel: '移动',
        })
        if (!ok) return
      }
    }
    await finish(items, await api.transfer(req))
  } catch (err) {
    ui.toast({ message: transferError(err), tone: 'error' })
  }
}

function transferError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'workspace_vault_unavailable') {
    const ws = typeof err.body.workspace === 'string' ? err.body.workspace : ''
    const name = ws ? workspaceName(useWorkspace.getState().list, ws) : ''
    return `${name ? `工作空间“${name}”` : '工作空间'}的文件夹不可用，未做任何改动`
  }
  return `${errorMessage(err)}，未做任何改动`
}

/** 完成后：刷新笔记树和工作空间列表（笔记数），打开的笔记被移走时回到首页，提示结果和改名项。 */
async function finish(items: TransferItem[], res: TransferResult) {
  const ui = useUI.getState()
  if (res.mode === 'move') {
    const gone = affectedNotes(items, useVault.getState().notes)
    const route = ui.route
    if (route.view === 'note' && gone.has(route.id)) {
      useEditor.getState().close()
      ui.navigate({ view: 'home' }, true)
    }
  }
  await useVault.getState().load().catch(() => {})
  void useWorkspace.getState().load()
  const name = workspaceName(useWorkspace.getState().list, res.target_workspace)
  ui.toast({
    message: resultMessage(res, name),
    tone: 'success',
    action:
      res.renamed.length > 3
        ? { label: '查看改名', run: () => void showRenamed(res) }
        : { label: '前往', run: () => void useWorkspace.getState().switchTo(res.target_workspace) },
  })
}

function showRenamed(res: TransferResult) {
  return customDialog<true>((done) => (
    <div className="dialog" data-testid="transfer-renamed-dialog">
      <h2 className="dialog-title" id="dialog-title">
        重名已自动改名
      </h2>
      <ul className="transfer-renamed">
        {res.renamed.map((r) => (
          <li key={`${r.kind}:${r.from}`}>{renameLabel(r)}</li>
        ))}
      </ul>
      <div className="dialog-actions">
        <Button variant="primary" onClick={() => done(true)}>
          好
        </Button>
      </div>
    </div>
  ))
}

interface Plan {
  broken: number
  renamed: string[]
}

function TransferForm({ items, mode, done }: { items: TransferItem[]; mode: TransferMode; done: (r: TransferResult | null) => void }) {
  const current = useWorkspace((s) => s.current)
  const targets = useWorkspace((s) => s.list).filter((w) => w.id !== current)
  const [target, setTarget] = useState<string>(targets[0]?.id ?? '')
  const [dir, setDir] = useState('')
  const [folders, setFolders] = useState<string[] | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  const dirId = useId()
  const verb = mode === 'move' ? '移动' : '复制'
  const what = describeItems(items, useVault.getState().notes)

  useLayoutEffect(() => first.current?.focus(), [])

  // 目标工作空间的文件夹列表
  useEffect(() => {
    if (!target) return
    let live = true
    setFolders(null)
    setFolderError(null)
    setDir('')
    workspaceApi(target)
      .tree()
      .then((t) => live && setFolders([...t.folders].sort((a, b) => a.localeCompare(b, 'zh-CN'))))
      .catch((err) => live && (setFolders([]), setFolderError(transferError(err).replace(/，未做任何改动$/, ''))))
    return () => {
      live = false
    }
  }, [target])

  // 预演：会失效的链接数（移动时）和会自动改名的条目
  useEffect(() => {
    if (!target || folderError) return setPlan(null)
    let live = true
    setPlan(null)
    api
      .transfer({ items, target_workspace: target, target_dir: dir, mode, dry_run: true })
      .then((r) => live && setPlan({ broken: r.broken_links, renamed: r.renamed.map(renameLabel) }))
      .catch(() => live && setPlan(null))
    return () => {
      live = false
    }
  }, [items, target, dir, mode, folderError])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !target) return
    setFailure(null)
    setBusy(true)
    const problem = await settle()
    if (problem) {
      setBusy(false)
      return setFailure(problem)
    }
    try {
      done(await api.transfer({ items, target_workspace: target, target_dir: dir, mode }))
    } catch (err) {
      setBusy(false)
      setFailure(transferError(err))
    }
  }

  return (
    <form className="dialog transfer-dialog" onSubmit={(e) => void submit(e)} data-testid="transfer-dialog" data-mode={mode}>
      <h2 className="dialog-title" id="dialog-title">
        把{what}{verb}到工作空间
      </h2>
      <fieldset className="transfer-targets">
        <legend className="field-label">工作空间</legend>
        {targets.map((w: WorkspaceInfo, i) => (
          <label key={w.id} className={`transfer-target${w.id === target ? ' is-selected' : ''}`}>
            <input
              ref={i === 0 ? first : undefined}
              type="radio"
              name="transfer-target"
              value={w.id}
              checked={w.id === target}
              onChange={() => setTarget(w.id)}
              data-testid={`transfer-target-${w.id}`}
            />
            <span className="transfer-target-name">{w.name}</span>
            <span className="transfer-target-hint">{w.external ? '外部文件夹' : `${w.note_count} 篇`}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="field-label" htmlFor={dirId}>
          目标文件夹
        </label>
        <select
          id={dirId}
          className="transfer-select"
          value={dir}
          disabled={!folders || !!folderError}
          onChange={(e) => setDir(e.target.value)}
          data-testid="transfer-dir"
        >
          <option value="">根目录</option>
          {folders?.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {folderError && (
          <p className="field-error" data-testid="transfer-folder-error">
            {folderError}
          </p>
        )}
      </div>
      <div className="transfer-notes" aria-live="polite">
        {mode === 'move' && plan && plan.broken > 0 && (
          <p className="transfer-warning" data-testid="transfer-broken-links">
            {brokenLinksWarning(plan.broken)}
          </p>
        )}
        {mode === 'move' && <p className="transfer-hint">原来的笔记会移到本工作空间的回收站，可以恢复；历史版本不随笔记移动。</p>}
        {plan && plan.renamed.length > 0 && (
          <p className="transfer-hint" data-testid="transfer-renames">
            重名会自动改名：{plan.renamed.slice(0, 3).join('，')}
            {plan.renamed.length > 3 ? ` 等 ${plan.renamed.length} 项` : ''}
          </p>
        )}
      </div>
      {failure && (
        <p className="field-error" role="alert" data-testid="transfer-error">
          {failure}
        </p>
      )}
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => done(null)}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !target || !!folderError} data-testid="transfer-submit">
          {busy ? <Spinner size={14} /> : null}
          {verb}
        </Button>
      </div>
    </form>
  )
}

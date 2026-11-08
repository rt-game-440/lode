import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, errorMessage } from '../../api/client'
import type { WorkspaceInfo } from '../../api/types'
import { customDialog } from '../../components/overlays'
import { Button, Spinner, TextField } from '../../components/ui'
import { useWorkspace } from '../../stores/workspace'
import { invalidWorkspaceName, looksAbsolute } from './names'

/** 新建工作空间的对话框：名称，可选“使用已有文件夹”（服务器上的绝对路径，比如已有的 Obsidian 库）。
 *  创建成功返回新工作空间，取消返回 null。路径不合法等服务器拒绝的原因直接显示在路径输入框下面。 */
export function createWorkspaceDialog(): Promise<WorkspaceInfo | null> {
  return customDialog<WorkspaceInfo | null>((done) => <CreateWorkspaceForm done={done} />)
}

function CreateWorkspaceForm({ done }: { done: (ws: WorkspaceInfo | null) => void }) {
  const [name, setName] = useState('')
  const [external, setExternal] = useState(false)
  const [dir, setDir] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  const hintId = useId()

  useLayoutEffect(() => nameInput.current?.focus(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const nErr = invalidWorkspaceName(name)
    const dErr = !external ? null : !dir.trim() ? '请填写文件夹的绝对路径' : !looksAbsolute(dir) ? '必须是绝对路径，例如 D:\\笔记\\我的库 或 /home/me/vault' : null
    setNameError(nErr)
    setDirError(dErr)
    setFailure(null)
    if (nErr) return nameInput.current?.focus()
    if (dErr) return dirInput.current?.focus()
    setBusy(true)
    try {
      done(await useWorkspace.getState().create(name.trim(), external ? dir.trim() : undefined))
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.code.startsWith('vault_dir_')) {
        setDirError(err.message)
        dirInput.current?.focus()
      } else if (err instanceof ApiError && err.code === 'bad_request') {
        setNameError(err.message)
        nameInput.current?.focus()
      } else {
        setFailure(errorMessage(err))
      }
    }
  }

  return (
    <form className="dialog" onSubmit={(e) => void submit(e)} data-testid="create-workspace-dialog">
      <h2 className="dialog-title" id="dialog-title">
        新建工作空间
      </h2>
      <TextField
        ref={nameInput}
        label="名称"
        placeholder="例如：工作"
        value={name}
        error={nameError}
        onChange={(e) => {
          setName(e.target.value)
          setNameError(null)
        }}
        data-testid="create-workspace-name"
      />
      <label className="ws-create-toggle">
        <span className="ws-create-toggle-text">
          <span>使用已有文件夹</span>
          <span className="ws-create-hint" id={hintId}>
            把服务器上已有的文件夹（比如 Obsidian 库）接入进来，笔记文件留在原处，可以继续在原来的软件里编辑。
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={external}
          aria-describedby={hintId}
          onChange={(e) => {
            setExternal(e.target.checked)
            setDirError(null)
          }}
          data-testid="create-workspace-external"
        />
      </label>
      {external && (
        <>
          <TextField
            ref={dirInput}
            label="文件夹路径"
            placeholder={'D:\\笔记\\我的库 或 /home/me/vault'}
            value={dir}
            error={dirError}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setDir(e.target.value)
              setDirError(null)
            }}
            data-testid="create-workspace-dir"
          />
          <p className="ws-create-hint" data-testid="create-workspace-dir-note">
            填写运行 Lode 的那台机器上的绝对路径。Lode 只读写里面的 Markdown 文件，不会在里面创建别的文件；索引和回收站放在数据目录。
            不要让两个 Lode 实例使用同一个文件夹。
          </p>
        </>
      )}
      {failure && (
        <p className="field-error" role="alert">
          {failure}
        </p>
      )}
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => done(null)}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={busy} data-testid="create-workspace-submit">
          {busy ? <Spinner size={14} /> : null}
          {external ? '接入' : '创建'}
        </Button>
      </div>
    </form>
  )
}

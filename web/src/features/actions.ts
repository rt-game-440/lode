// 跨界面复用的笔记操作：带提示、确认和错误处理。
import { ApiError } from '../api/client'
import type { Note } from '../api/types'
import { confirmDialog, promptDialog } from '../components/overlays'
import { basename, dirname, invalidNameReason, join } from '../lib/paths'
import { LinkResolver } from '../lib/wikilink'
import { requestTitleFocus } from './editor/editorRef'
import { useEditor } from '../stores/editor'
import { useUI } from '../stores/ui'
import { findByPath, useVault } from '../stores/vault'

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'exists':
        return '同名的笔记或文件夹已存在'
      case 'invalid_path':
        return '名称不合法'
      case 'not_found':
        return '笔记不存在，可能已被删除'
      case 'conflict':
        return '笔记已在别处被修改'
      case 'network':
        return '网络不可用'
    }
    return err.message || '操作失败'
  }
  return err instanceof Error ? err.message : String(err)
}

function toastError(err: unknown) {
  useUI.getState().toast({ message: errorMessage(err), tone: 'error' })
}

export function openNote(id: string) {
  useUI.getState().navigate({ view: 'note', id })
  rememberRecent(id)
}

/** 在 dir 下新建笔记并打开。 */
export async function newNote(dir = '', name?: string): Promise<Note | null> {
  try {
    const n = await useVault.getState().createNote(dir, name)
    if (!name) requestTitleFocus(n.id)
    openNote(n.id)
    return n
  } catch (err) {
    toastError(err)
    return null
  }
}

export async function newFolder(parent = ''): Promise<void> {
  const name = await promptDialog({
    title: '新建文件夹',
    label: '名称',
    placeholder: '文件夹名称',
    confirmLabel: '创建',
    validate: invalidNameReason,
  })
  if (name === null) return
  try {
    await useVault.getState().createFolder(join(parent, name.trim()))
  } catch (err) {
    toastError(err)
  }
}

/** 重命名笔记（只改名称，不改目录）。返回是否成功。 */
export async function renameNote(note: Note, newName: string): Promise<boolean> {
  const name = newName.trim()
  if (name === note.title) return true
  const reason = invalidNameReason(name)
  if (reason) {
    useUI.getState().toast({ message: reason, tone: 'error' })
    return false
  }
  try {
    const res = await useVault.getState().moveNote(note.id, join(dirname(note.path), `${name}.md`))
    if (res.updated.length) useUI.getState().toast({ message: `已更新 ${res.updated.length} 篇笔记中的链接` })
    return true
  } catch (err) {
    toastError(err)
    return false
  }
}

export async function promptRenameNote(note: Note) {
  const name = await promptDialog({
    title: '重命名笔记',
    label: '名称',
    initial: note.title,
    confirmLabel: '重命名',
    validate: invalidNameReason,
  })
  if (name !== null) await renameNote(note, name)
}

export async function moveNoteTo(note: Note, dir: string) {
  if (dirname(note.path) === dir) return
  try {
    const res = await useVault.getState().moveNote(note.id, join(dir, basename(note.path)))
    if (res.updated.length) useUI.getState().toast({ message: `已更新 ${res.updated.length} 篇笔记中的链接` })
  } catch (err) {
    toastError(err)
  }
}

export async function deleteNote(note: Note) {
  try {
    await useVault.getState().deleteNote(note.id)
    const ui = useUI.getState()
    if (ui.route.view === 'note' && ui.route.id === note.id) {
      useEditor.getState().close()
      ui.navigate({ view: 'home' }, true)
    }
    ui.toast({
      message: `“${note.title}”已移到回收站`,
      action: {
        label: '撤销',
        run: () => {
          void useVault
            .getState()
            .restoreNote(note.id)
            .catch(toastError)
        },
      },
    })
  } catch (err) {
    toastError(err)
  }
}

export async function promptRenameFolder(path: string) {
  const name = await promptDialog({
    title: '重命名文件夹',
    label: '名称',
    initial: basename(path),
    confirmLabel: '重命名',
    validate: invalidNameReason,
  })
  if (name === null || name.trim() === basename(path)) return
  try {
    await useVault.getState().moveFolder(path, join(dirname(path), name.trim()))
  } catch (err) {
    toastError(err)
  }
}

export async function moveFolderTo(path: string, dir: string) {
  if (dirname(path) === dir || dir === path || dir.startsWith(path + '/')) return
  try {
    await useVault.getState().moveFolder(path, join(dir, basename(path)))
  } catch (err) {
    toastError(err)
  }
}

export async function deleteFolder(path: string) {
  const notes = Object.values(useVault.getState().notes).filter((n) => n.path.startsWith(path + '/'))
  const ok = await confirmDialog({
    title: `删除文件夹“${basename(path)}”？`,
    message: notes.length ? `其中的 ${notes.length} 篇笔记会移到回收站，可以从回收站恢复。` : '这个文件夹是空的。',
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    const n = await useVault.getState().deleteFolder(path)
    const ui = useUI.getState()
    if (ui.route.view === 'note' && notes.some((x) => ui.route.view === 'note' && x.id === ui.route.id)) {
      useEditor.getState().close()
      ui.navigate({ view: 'home' }, true)
    }
    ui.toast({ message: n ? `已删除文件夹，${n} 篇笔记移到回收站` : '已删除文件夹' })
  } catch (err) {
    toastError(err)
  }
}

/** 打开 [[target]]：存在就跳转，否则在当前笔记所在目录新建。 */
export async function openWikiLink(target: string, srcPath: string) {
  const vault = useVault.getState()
  const notes = Object.values(vault.notes)
  const resolver = new LinkResolver(notes.map((n) => n.path))
  const t = target.trim()
  if (!t) return
  const path = resolver.resolve(t, srcPath)
  if (path) {
    const n = findByPath(vault.notes, path)
    if (n) openNote(n.id)
    return
  }
  const clean = t.replace(/\.md$/i, '')
  const dir = clean.includes('/') ? dirname(clean) : dirname(srcPath)
  const name = basename(clean)
  const reason = invalidNameReason(name)
  if (reason) {
    useUI.getState().toast({ message: reason, tone: 'error' })
    return
  }
  try {
    if (dir && !vault.folders.includes(dir)) await vault.createFolder(dir)
    const n = await vault.createNote(dir, name)
    openNote(n.id)
  } catch (err) {
    toastError(err)
  }
}

/* ---------- 最近打开 ---------- */

const RECENT_KEY = 'lode.recent'

export function recentIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rememberRecent(id: string) {
  const list = [id, ...recentIds().filter((x) => x !== id)].slice(0, 30)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

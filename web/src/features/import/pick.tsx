// 选择本地文件 / 文件夹并导入。
import { FileUp, FolderUp } from 'lucide-react'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { runImportFlow } from './flow'

const FOLDER_SUPPORTED = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

function pickFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.hidden = true
    input.setAttribute('data-testid', folder ? 'import-folder-input' : 'import-file-input')
    if (folder) input.webkitdirectory = true
    else {
      input.multiple = true
      input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    }
    const finish = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

/** 选择并导入到 dir（vault 相对目录，'' 为根）。 */
export async function importInto(dir: string, folder: boolean): Promise<void> {
  const files = await pickFiles(folder)
  if (!files.length) return
  await runImportFlow(
    files.map((file) => ({ file, relPath: folder ? file.webkitRelativePath || file.name : file.name })),
    dir,
  )
}

/** “导入”菜单项（文件 / 文件夹）。 */
export function importEntries(dir: string): MenuEntry[] {
  const items: MenuEntry[] = [{ label: '导入文件…', icon: <FileUp size={16} />, run: () => void importInto(dir, false) }]
  if (FOLDER_SUPPORTED) items.push({ label: '导入文件夹…', icon: <FolderUp size={16} />, run: () => void importInto(dir, true) })
  return items
}

export function openImportMenu(at: HTMLElement, dir: string) {
  openMenu(at, importEntries(dir))
}

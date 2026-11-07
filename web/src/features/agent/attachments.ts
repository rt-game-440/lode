import type { Attachment } from '../../api/agent'

/** 读取文件为附件（base64）。 */
export function fileToAttachment(file: Blob, name: string): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      resolve({ name, mime: file.type, data: url.slice(url.indexOf(',') + 1) })
    }
    r.onerror = () => reject(r.error ?? new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

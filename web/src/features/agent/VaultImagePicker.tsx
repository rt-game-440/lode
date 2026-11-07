import { useEffect, useState } from 'react'
import type { Attachment } from '../../api/agent'
import { api, fileUrl } from '../../api/client'
import { Modal } from '../../components/Modal'
import { EmptyState, Spinner } from '../../components/ui'
import { basename } from '../../lib/paths'
import { useUI } from '../../stores/ui'
import { errorMessage } from '../actions'
import { fileToAttachment } from './attachments'

type Image = { path: string; size: number; mtime: number }

/** 从笔记库里选一张图片作为附件。 */
export function VaultImagePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (a: Attachment) => void }) {
  const [images, setImages] = useState<Image[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useUI((s) => s.toast)

  useEffect(() => {
    if (!open) return
    setImages(null)
    api
      .images()
      .then(setImages)
      .catch((err) => {
        toast({ message: errorMessage(err), tone: 'error' })
        setImages([])
      })
  }, [open, toast])

  const pick = async (img: Image) => {
    setBusy(img.path)
    try {
      const res = await fetch(fileUrl(img.path), { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onPick(await fileToAttachment(await res.blob(), basename(img.path)))
      onClose()
    } catch (err) {
      toast({ message: `读取图片失败：${errorMessage(err)}`, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="选择笔记库里的图片" className="image-picker">
      <h2 className="image-picker-title">笔记库里的图片</h2>
      {!images ? (
        <div className="view-loading">
          <Spinner />
        </div>
      ) : !images.length ? (
        <EmptyState title="笔记库里还没有图片">在笔记里粘贴或拖入图片后，会出现在这里</EmptyState>
      ) : (
        <ul className="image-grid" aria-label="图片">
          {images.map((img) => (
            <li key={img.path}>
              <button type="button" className="image-cell" title={img.path} disabled={busy !== null} onClick={() => void pick(img)}>
                <img src={fileUrl(img.path)} alt="" loading="lazy" />
                <span className="image-name">{basename(img.path)}</span>
                {busy === img.path && <Spinner size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

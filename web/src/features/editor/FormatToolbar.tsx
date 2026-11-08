import { startCompletion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { Bold, Brackets, Code, Hash, Image as ImageIcon, Italic, Link, List, ListTodo, TextQuote } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { insertImages } from './cm/extras'
import { FORMAT_ACTIONS, type FormatId } from './cm/formatActions'

interface Props {
  view: EditorView
  upload: (file: File) => Promise<string>
  onUploadError: (err: unknown) => void
}

const ICONS: Record<FormatId, ReactNode> = {
  heading: <Hash size={16} />,
  bold: <Bold size={16} />,
  italic: <Italic size={16} />,
  code: <Code size={16} />,
  list: <List size={16} />,
  task: <ListTodo size={16} />,
  quote: <TextQuote size={16} />,
  link: <Link size={16} />,
  wikilink: <Brackets size={16} />,
}

/** 桌面端格式顶栏：位于标题栏下方，按钮复用与手机工具栏相同的编辑命令。 */
export function FormatToolbar({ view, upload, onUploadError }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="format-toolbar" role="toolbar" aria-label="格式" data-testid="format-toolbar">
      {FORMAT_ACTIONS.map((a) => (
        <FormatButton
          key={a.id}
          label={a.label}
          title={`${a.label}（${a.shortcut}）`}
          onPress={() => {
            view.dispatch(a.run(view.state))
            view.focus()
            if (a.id === 'wikilink') startCompletion(view)
          }}
        >
          {ICONS[a.id]}
        </FormatButton>
      ))}
      <FormatButton label="图片" title="插入图片" onPress={() => fileRef.current?.click()}>
        <ImageIcon size={16} />
      </FormatButton>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="format-image-input"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          view.focus()
          void insertImages(view, files, upload, onUploadError)
        }}
      />
    </div>
  )
}

function FormatButton({ label, title, onPress, children }: { label: string; title: string; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn-md"
      aria-label={label}
      title={title}
      // 不抢编辑器焦点，选区保持
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

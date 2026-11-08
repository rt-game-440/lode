import { useEditorPrefs } from '../../stores/editorPrefs'

/** 编辑偏好（本机保存）。设置页重构时整块搬走即可，存储逻辑在 stores/editorPrefs。 */
export function EditorPrefsSection() {
  const show = useEditorPrefs((s) => s.formatToolbar)
  const setShow = useEditorPrefs((s) => s.setFormatToolbar)
  return (
    <section className="settings-group" aria-labelledby="settings-editor">
      <h2 id="settings-editor" className="settings-heading">
        编辑
      </h2>
      <div className="settings-card">
        <label className="settings-row">
          <span className="settings-row-text row-stack">
            <span className="settings-row-label">显示格式工具栏</span>
            <span className="settings-meta">电脑上在编辑区标题栏下方显示加粗、斜体等格式按钮。只影响这台设备。</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            data-testid="format-toolbar-switch"
          />
        </label>
      </div>
    </section>
  )
}

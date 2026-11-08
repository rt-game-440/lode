import { Check, Keyboard } from 'lucide-react'
import { useEditorPrefs } from '../../stores/editorPrefs'
import { type Theme, useUI } from '../../stores/ui'
import { SHORTCUT_GROUPS } from '../shell/ShortcutsDialog'
import { ActionRow, Group, SettingsPage } from './parts'
import { SECTION_TITLE } from './stack'

// 设置里的“通用”：外观、编辑器、键盘。

export const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

export const SHORTCUT_COUNT = SHORTCUT_GROUPS.reduce((n, g) => n + g.items.length, 0)

export function AppearancePage({ sub }: { sub: string[] }) {
  const theme = useUI((s) => s.theme)
  const setTheme = useUI((s) => s.setTheme)
  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.appearance}>
      <Group title="主题" footer="跟随系统时随设备的浅色、深色模式自动切换。侧栏底部的主题按钮也可以快速切换。">
        <div role="radiogroup" aria-label="主题" className="choice-list">
          {(Object.keys(THEME_LABEL) as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              className="settings-row choice-row"
              onClick={() => setTheme(t)}
            >
              <span className="choice-label">{THEME_LABEL[t]}</span>
              {theme === t && <Check size={18} className="choice-check" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </Group>
    </SettingsPage>
  )
}

/** 编辑偏好只存在这台设备上（stores/editorPrefs）。 */
export function EditorPage({ sub }: { sub: string[] }) {
  const show = useEditorPrefs((s) => s.formatToolbar)
  const setShow = useEditorPrefs((s) => s.setFormatToolbar)
  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.editor}>
      <Group title="编辑">
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
      </Group>
    </SettingsPage>
  )
}

export function KeyboardPage({ sub }: { sub: string[] }) {
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.keyboard}>
      <p className="settings-desc">所有功能都可以只用键盘完成；不在输入时按 ? 随时查看。</p>
      {SHORTCUT_GROUPS.map((g) => (
        <Group key={g.title} title={g.title}>
          <dl className="shortcut-list">
            {g.items.map((it) => (
              <div key={it.label} className="settings-row shortcut-row">
                <dt>{it.label}</dt>
                <dd>
                  {it.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Group>
      ))}
      <Group>
        <ActionRow icon={<Keyboard size={16} aria-hidden="true" />} onClick={() => setShortcutsOpen(true)}>
          在弹窗中查看快捷键
        </ActionRow>
      </Group>
    </SettingsPage>
  )
}

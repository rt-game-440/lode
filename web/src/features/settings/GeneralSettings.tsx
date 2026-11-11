import { Check, Keyboard } from 'lucide-react'
import { useId } from 'react'
import { RadioGroup } from '../../components/RadioGroup'
import { FONT_SIZE_LABEL, FONT_SIZES, useDisplayPrefs } from '../../stores/displayPrefs'
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
      <FontSizeGroup />
    </SettingsPage>
  )
}

/** 整体字号（#47）：改的是根元素字号，整个设置页本身就是实时预览；下方再放一段笔记正文的样子。 */
function FontSizeGroup() {
  const size = useDisplayPrefs((s) => s.fontSize)
  const setSize = useDisplayPrefs((s) => s.setFontSize)
  const id = useId()
  return (
    <Group title={<span id={id}>字号</span>} footer="界面和笔记正文一起缩放，以浏览器的默认字号为基准。只影响这台设备。">
      <div className="font-size-control">
        <span className="font-size-glyph is-small" aria-hidden="true">
          A
        </span>
        <RadioGroup
          labelledBy={id}
          className="segmented font-size-options"
          value={size}
          options={FONT_SIZES.map((s) => ({ value: s, label: FONT_SIZE_LABEL[s] }))}
          itemClass={(on) => `segment${on ? ' is-selected' : ''}`}
          onChange={setSize}
        />
        <span className="font-size-glyph is-large" aria-hidden="true">
          A
        </span>
      </div>
      <div className="font-size-preview" data-testid="font-size-preview">
        <p className="font-size-preview-title">预览</p>
        <p className="font-size-preview-body">春天的夜晚，江水平静，月亮从海上升起。调整字号后，侧栏、菜单和笔记正文会一起变大或变小。</p>
      </div>
    </Group>
  )
}

/** 编辑偏好只存在这台设备上（stores/editorPrefs）。 */
export function EditorPage({ sub }: { sub: string[] }) {
  const show = useEditorPrefs((s) => s.formatToolbar)
  const setShow = useEditorPrefs((s) => s.setFormatToolbar)
  const toc = useEditorPrefs((s) => s.tocRail)
  const setToc = useEditorPrefs((s) => s.setTocRail)
  const browseDefault = useEditorPrefs((s) => s.browseByDefault)
  const setBrowseDefault = useEditorPrefs((s) => s.setBrowseByDefault)
  return (
    <SettingsPage sub={sub} title={SECTION_TITLE.editor}>
      <Group title="编辑">
        <label className="settings-row">
          <span className="settings-row-text row-stack">
            <span className="settings-row-label">打开笔记时默认仅浏览</span>
            <span className="settings-meta">打开笔记时直接进入仅浏览（不能改字、不弹键盘，表格和链接照常显示，任务仍可勾选），需要改时点笔记顶栏的“仅浏览”按钮。只影响这台设备。</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={browseDefault}
            onChange={(e) => setBrowseDefault(e.target.checked)}
            data-testid="browse-default-switch"
          />
        </label>
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
        <label className="settings-row">
          <span className="settings-row-text row-stack">
            <span className="settings-row-label">显示目录条</span>
            <span className="settings-meta">电脑上在正文右侧显示一列细线表示标题，鼠标移上去展开目录。也可在笔记的“外观和布局”里切换。只影响这台设备。</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={toc}
            onChange={(e) => setToc(e.target.checked)}
            data-testid="toc-rail-switch"
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

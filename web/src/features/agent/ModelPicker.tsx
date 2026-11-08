import { ChevronDown } from 'lucide-react'
import { EFFORT_LABEL, type Effort, type Modality } from '../../api/agent'
import { type MenuEntry, openMenu } from '../../components/overlays'
import { type ModelOption, chatModel, enabledModels, useAgent } from '../../stores/agent'

const MODALITY_LABEL: Record<Modality, string> = { text: '文字', image: '图片', pdf: 'PDF', audio: '音频' }

/** 显示名；没有显示名时用简短 ID（去掉 “供应商/” 之类的前缀）。 */
export function modelLabel(m: { name?: string; model: string }): string {
  if (m.name) return m.name
  const i = m.model.lastIndexOf('/')
  return i >= 0 && i < m.model.length - 1 ? m.model.slice(i + 1) : m.model
}

/** 能力提示：推理、图片等（纯文字不写）。 */
export function modelHint(m: Pick<ModelOption, 'reasoning' | 'modalities'>): string {
  return [...(m.reasoning ? ['推理'] : []), ...m.modalities.filter((x) => x !== 'text').map((x) => MODALITY_LABEL[x])].join(' · ')
}

/**
 * 输入框里的模型选择器：收起时是轻量的文字按钮，展开是应用统一的菜单（和“更多操作”同一套组件）。
 * 按供应商分组，当前项打勾；支持推理的模型在同一个菜单里切换推理强度。
 */
export function ModelPicker() {
  const config = useAgent((s) => s.config)
  const current = useAgent((s) => s.current)
  const setModel = useAgent((s) => s.setModel)
  const setEffort = useAgent((s) => s.setEffort)
  const model = chatModel(config, current?.chat)
  const models = enabledModels(config)
  const running = current?.running ?? false
  if (!models.length) return null

  const show = (e: React.MouseEvent<HTMLButtonElement>) => {
    const items: MenuEntry[] = []
    const groups = new Map<string, ModelOption[]>()
    for (const m of models) groups.set(m.provider.id, [...(groups.get(m.provider.id) ?? []), m])
    for (const list of groups.values()) {
      if (items.length) items.push('separator')
      items.push({ heading: list[0].provider.name })
      for (const m of list) {
        items.push({ label: modelLabel(m), hint: modelHint(m), checked: m.id === model?.id, run: () => void setModel(m.id) })
      }
    }
    if (model?.reasoning) {
      const effort = current?.chat.effort ?? ''
      items.push('separator', { heading: '推理强度' })
      items.push({ label: `默认（${EFFORT_LABEL[model.effort]}）`, checked: effort === '', run: () => void setEffort('') })
      for (const k of Object.keys(EFFORT_LABEL) as Effort[]) {
        items.push({ label: EFFORT_LABEL[k], checked: effort === k, run: () => void setEffort(k) })
      }
    }
    openMenu(e.currentTarget, items)
  }

  const label = model ? modelLabel(model) : '选择模型'
  const full = model ? `${model.name || model.model} · ${model.provider.name}` : '选择模型'
  return (
    <button
      type="button"
      className="composer-model"
      aria-haspopup="menu"
      aria-label={`模型：${label}`}
      title={full}
      disabled={running}
      onClick={show}
      data-testid="model-select"
    >
      <span className="composer-model-name">{label}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  )
}

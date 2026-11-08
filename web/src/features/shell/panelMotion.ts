import { type MotionValue, animate, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { springPanel } from '../../styles/tokens/motion'

export interface PanelMotion {
  /** 展开进度 0–1，由弹簧驱动；动画途中再次切换会从当前进度和速度平滑掉头。 */
  progress: MotionValue<number>
  /**
   * 面板当前露出的宽度（px）= 进度 × 面板宽度，也就是面板靠近主区域那条边到窗口边缘的距离。
   * 主区域的左右边缘逐帧贴住它；拖拽调宽时进度为 1，边缘直接跟随宽度。
   */
  edge: MotionValue<number>
  /** 面板是否可见（展开中、已展开或正在收起）。为 false 时内容设为 inert。 */
  visible: boolean
}

/**
 * 侧栏 / 右栏的展开收起：面板本身只动 transform，露出的宽度由 `edge` 给出，
 * 主区域用它逐帧调整左右边缘（见 AppShell 的 DesktopShell），标题栏按钮因此始终贴着面板边缘、一直可见。
 * 动画驱动的是进度而不是像素，所以面板宽度在动画中变化（调宽、切换助手加宽）时边缘也不会脱节。
 */
export function usePanelMotion(open: boolean, width: MotionValue<number>): PanelMotion {
  const reduced = useReducedMotion()
  const progress = useMotionValue(open ? 1 : 0)
  const edge = useTransform(() => progress.get() * width.get())
  const [visible, setVisible] = useState(open)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (open) setVisible(true)
    const done = () => {
      if (!open) setVisible(false)
    }
    const target = open ? 1 : 0
    if (reduced) {
      progress.set(target)
      done()
      return
    }
    const controls = animate(progress, target, { ...springPanel, onComplete: done })
    return () => controls.stop()
  }, [open, reduced, progress])

  // 展开时当次渲染就显示，不等 effect 里的 setVisible，否则第一帧主区域已经让出边缘、面板还是隐藏的
  return { progress, edge, visible: open || visible }
}

/**
 * 桌面三栏中侧栏、右栏靠近主区域那条边的位置（露出宽度，px），由 DesktopShell 提供。
 * 主区域里的元素天然跟着两条边走；放在主区域以外、又要沿侧栏边缘移动的元素（例如侧栏的收起按钮）读这里。
 */
export interface PanelEdges {
  left: MotionValue<number>
  right: MotionValue<number>
}

export const PanelEdgesContext = createContext<PanelEdges | null>(null)

/** 桌面三栏之外（手机布局）返回 null。 */
export function usePanelEdges(): PanelEdges | null {
  return useContext(PanelEdgesContext)
}

import { type MotionValue, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { type ReactNode, type Ref, createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../../components/ui'
import { fadeOutQuick, fadeTransition } from '../../styles/tokens/motion'

/*
 * 侧栏 / 右栏的收起按钮（#19）。
 *
 * 按钮浮在三栏之上，不属于任何一栏：面板展开时它停在面板标题行靠编辑区的那一端
 * （侧栏标题行最右、右栏标签行最左，两侧对称）；面板收起时它跟着面板边缘移动，
 * 最后停在编辑区标题栏同侧的角上，成为展开按钮。全程是同一个元素，所以不会先消失再出现。
 *
 * - 面板标题行里用 PanelToggleAnchor 占住按钮的位置；
 * - 主区域的标题栏里用 PanelToggleSlot 给停在角上的按钮让位，宽度逐帧跟着按钮变化，
 *   标题栏内容平滑地让开，不会在动画结束时跳一下。
 */

type Side = 'left' | 'right'

/** 侧栏、右栏靠主区域一侧的分隔线宽度（shell.css 的 border） */
const SEPARATOR = 1
/**
 * 按钮从“贴着面板边缘”转到“停在角上”的过渡半径（px）。
 * 用二次曲线衔接两段直线，按钮的速度连续变化，不会到角上时一下刹住，展开时也不会被边缘一下带走。
 * 逐帧采集（62.5fps）：展开起步那一帧按钮的单帧位移变化，16 时约是面板自身最大值的 1.6 倍，28 时约 1.3 倍。
 * 越大，按钮离开面板边缘越早（面板露出 < 49 + 半径 时开始离开）；
 * 上限是“分隔线 + 2 × 内边距 + 按钮宽度”（49px），否则面板完全收起时按钮到不了角上。
 */
const CORNER_EASE = 28
/**
 * 标题栏让位宽度的过渡半径（px）。要小于面板展开时按钮离主区域的距离
 * （分隔线 + 内边距 + 标题栏内边距 − 间距 ≈ 13px），保证面板展开时标题栏完全不让位。
 */
const SLOT_EASE = 8

/** 平滑的 max(0, x)：|x| ≥ r 时与 max(0, x) 完全相同，中间用二次曲线衔接，一阶导数连续。 */
export function softPlus(x: number, r: number): number {
  if (x <= -r) return 0
  if (x >= r) return x
  return (x + r) ** 2 / (4 * r)
}

/**
 * 收起按钮离同侧窗口边缘的距离（左按钮是 left，右按钮是 right）。
 * - 面板露出较多时：按钮贴着面板靠主区域的边，和边缘之间隔着分隔线和标题行内边距；
 * - 面板收起后：按钮停在主区域标题栏的角上，离窗口边缘一个内边距。
 *
 * @param edge 面板露出的宽度（px），见 usePanelMotion 的 edge
 * @param size 按钮宽度
 * @param inset 标题栏 / 标题行的水平内边距（--space-2）
 */
export function toggleOffset(edge: number, size: number, inset: number): number {
  return inset + softPlus(edge - (SEPARATOR + 2 * inset + size), CORNER_EASE)
}

/**
 * 主区域标题栏为按钮让出的宽度。
 * @param cover 按钮伸进主区域的宽度（从主区域同侧边缘量起；按钮还在面板里时为负）
 * @param gap 标题栏子元素的间距
 * @param pad 标题栏同侧的内边距
 */
export function slotWidth(cover: number, gap: number, pad: number): number {
  return softPlus(cover + gap - pad, SLOT_EASE)
}

interface ToggleCovers {
  left: MotionValue<number>
  right: MotionValue<number>
}

interface PanelToggleLayout {
  /** 两个按钮伸进主区域的宽度（px），供 PanelToggleSlot 计算让位 */
  cover: ToggleCovers
  /** 右栏收起按钮是否显示（只在笔记页） */
  right: boolean
}

const PanelToggleContext = createContext<PanelToggleLayout | null>(null)
export const PanelToggleProvider = PanelToggleContext.Provider

export interface PanelToggleMotion {
  side: Side
  /** 挂到按钮外层，测量按钮宽度和内边距 */
  ref: Ref<HTMLDivElement>
  x: MotionValue<number>
  opacity: MotionValue<number>
  cover: MotionValue<number>
}

/**
 * 收起按钮的位置。正常情况下逐帧由面板边缘算出；减弱动态效果时面板直接切换，
 * 按钮先在原处淡出，再在新位置淡入（拖拽调宽仍然直接跟随，不淡入淡出）。
 *
 * @param edge 面板露出的宽度（usePanelMotion 的 edge）
 * @param open 面板是否展开；它变化时（而不是宽度变化时）才在减弱动态效果下淡入淡出
 */
export function usePanelToggle(side: Side, edge: MotionValue<number>, open: boolean): PanelToggleMotion {
  const reduced = useReducedMotion()
  // 默认值对应 2rem 按钮和 --space-2 内边距，挂载后按实际测量（粗指针设备上按钮更大）
  const size = useMotionValue(32)
  const inset = useMotionValue(8)
  // 减弱动态效果时，淡出期间把按钮留在原处；NaN 表示跟随面板边缘
  const hold = useMotionValue(Number.NaN)
  const opacity = useMotionValue(1)
  const target = useTransform(() => toggleOffset(edge.get(), size.get(), inset.get()))
  const offset = useTransform(() => {
    const h = hold.get()
    return Number.isNaN(h) ? target.get() : h
  })
  // CSS 里已经离窗口边缘 inset，transform 只给多出来的部分；右按钮往左是负方向
  const x = useTransform(() => (side === 'left' ? 1 : -1) * (offset.get() - inset.get()))
  // 标题栏让位跟随面板的实际位置（减弱动态效果时和面板一起直接切换），不跟随淡出中的按钮
  const cover = useTransform(() => target.get() + size.get() - edge.get())

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return
      const measure = () => {
        size.set(el.offsetWidth)
        const parent = el.offsetParent as HTMLElement | null
        inset.set(side === 'left' || !parent ? el.offsetLeft : parent.clientWidth - el.offsetLeft - el.offsetWidth)
      }
      measure()
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    },
    [side, size, inset],
  )

  // 必须是 layout effect：面板在 usePanelMotion 的 useEffect 里才切换，这里先记下按钮的原位置
  const prevOpen = useRef(open)
  useLayoutEffect(() => {
    const changed = prevOpen.current !== open
    prevOpen.current = open
    if (!reduced) {
      hold.set(Number.NaN)
      opacity.set(1)
      return
    }
    if (!changed) return
    hold.set(offset.get())
    let controls = animate(opacity, 0, {
      ...fadeOutQuick,
      onComplete: () => {
        hold.set(Number.NaN)
        controls = animate(opacity, 1, fadeTransition)
      },
    })
    return () => controls.stop()
  }, [open, reduced, hold, opacity, offset])

  return { side, ref, x, opacity, cover }
}

/** 浮动的收起 / 展开按钮，由 DesktopShell 渲染；DOM 位置决定 Tab 顺序。 */
export function PanelToggle({
  toggle,
  label,
  onClick,
  children,
}: {
  toggle: PanelToggleMotion
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <motion.div
      ref={toggle.ref}
      className={`panel-toggle is-${toggle.side}`}
      style={{ x: toggle.x, opacity: toggle.opacity }}
      data-testid={`panel-toggle-${toggle.side}`}
    >
      <IconButton label={label} onClick={onClick}>
        {children}
      </IconButton>
    </motion.div>
  )
}

/**
 * 面板标题行里收起按钮的占位：面板展开时按钮正好浮在这里。
 * 只在桌面三栏里占位（手机布局、窄屏右栏抽屉里返回 null）。
 */
export function PanelToggleAnchor({ side }: { side: Side }) {
  const layout = useContext(PanelToggleContext)
  if (!layout || (side === 'right' && !layout.right)) return null
  return <span className="panel-toggle-anchor icon-btn-md" aria-hidden="true" />
}

/**
 * 主区域标题栏里给收起按钮让位的空白，放在标题栏的第一个（左）或最后一个（右）子元素。
 * 宽度逐帧跟着按钮变化；用负外边距抵消一份间距，宽度为 0 时标题栏和原来完全一样。
 * 只在桌面三栏里生效（手机布局里返回 null）。
 */
export function PanelToggleSlot({ side }: { side: Side }) {
  const layout = useContext(PanelToggleContext)
  const ref = useRef<HTMLSpanElement>(null)
  const pad = useMotionValue(8)
  const gap = useMotionValue(4)
  useLayoutEffect(() => {
    const bar = ref.current?.parentElement
    if (!bar) return
    const cs = getComputedStyle(bar)
    pad.set(parseFloat(side === 'left' ? cs.paddingLeft : cs.paddingRight) || 0)
    gap.set(parseFloat(cs.columnGap) || 0)
  }, [side, pad, gap])
  const cover = layout?.cover[side]
  const width = useTransform(() => (cover ? slotWidth(cover.get(), gap.get(), pad.get()) : 0))
  const margin = useTransform(() => -gap.get())
  if (!layout || (side === 'right' && !layout.right)) return null
  return (
    <motion.span
      ref={ref}
      className="panel-toggle-slot"
      aria-hidden="true"
      style={side === 'left' ? { width, marginRight: margin } : { width, marginLeft: margin }}
    />
  )
}

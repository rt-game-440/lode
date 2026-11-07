import { type MotionValue, animate, useMotionValue, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { springPanel } from '../../styles/tokens/motion'

export interface PanelMotion {
  /** 面板当前露出的宽度（px），由弹簧驱动，可被中途打断、反向。 */
  offset: MotionValue<number>
  /** 1 表示面板已稳定展开，主区域为它让出布局空间；动画过程中为 0。 */
  reserved: MotionValue<number>
  /** 面板是否可见（展开中、已展开或正在收起）。为 false 时内容设为 inert。 */
  visible: boolean
}

/**
 * 侧栏 / 右栏的展开收起只动 transform：
 * - 收起：主区域立即恢复全宽，面板和主区域一起平移出去；
 * - 展开：主区域保持全宽、随面板平移，动画结束后再让出空间。
 * 这样整个过程只有 transform 在变，主区域的宽度只在开始或结束时变一次。
 * 动画从当前值出发并继承速度，展开途中再次切换会平滑掉头。
 */
export function usePanelMotion(open: boolean, width: MotionValue<number>): PanelMotion {
  const reduced = useReducedMotion()
  const offset = useMotionValue(open ? width.get() : 0)
  const reserved = useMotionValue(open ? 1 : 0)
  const [visible, setVisible] = useState(open)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    reserved.set(0)
    if (open) setVisible(true)
    const done = () => {
      if (open) reserved.set(1)
      else setVisible(false)
    }
    const target = open ? width.get() : 0
    if (reduced) {
      offset.set(target)
      done()
      return
    }
    const controls = animate(offset, target, { ...springPanel, onComplete: done })
    return () => controls.stop()
  }, [open, reduced, offset, reserved, width])

  // 拖拽调宽：面板稳定展开时，露出宽度直接跟随宽度
  useEffect(
    () =>
      width.on('change', (w) => {
        if (reserved.get() === 1) offset.set(w)
      }),
    [width, offset, reserved],
  )

  return { offset, reserved, visible }
}

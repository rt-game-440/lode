import { type TargetAndTransition, useReducedMotion } from 'motion/react'

type Offset = { scale?: number; y?: number; x?: number }

/**
 * 弹出层的入场和退场：从略小、略偏的位置弹出。
 * 减弱动态效果时只淡入淡出——MotionConfig 只会跳过动画过程，initial 里的缩放和位移
 * 仍会在第一帧生效，所以这里直接去掉它们。
 */
export function usePop(from: Offset, to: Offset = from, exitExtra: TargetAndTransition = {}) {
  const reduced = useReducedMotion()
  if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, ...exitExtra } }
  return {
    initial: { opacity: 0, ...from },
    animate: { opacity: 1, scale: 1, x: 0, y: 0 },
    exit: { opacity: 0, ...to, ...exitExtra },
  }
}

import { AnimatePresence, type HTMLMotionProps, motion, useReducedMotion } from 'motion/react'
import { type ReactNode, forwardRef } from 'react'
import { fadeTransition, springDefault } from '../styles/tokens/motion'

/**
 * 列表增删动画（文件树、回收站、token 列表；阶段 5 的会话列表也用它）：
 * 新增项淡入，删除项淡出并立即让出位置，其余项用弹簧平移到新位置。
 * 父元素需要 position: relative（popLayout 会把退出项绝对定位）。
 */
export function ListPresence({ children }: { children: ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {children}
    </AnimatePresence>
  )
}

type ItemProps = HTMLMotionProps<'li'> & { as?: 'li' }
type DivItemProps = HTMLMotionProps<'div'> & { as: 'div' }

/** ListPresence 的直接子项。reduced motion 时只保留淡入淡出，不做位移和缩放。 */
export const ListItem = forwardRef<HTMLLIElement & HTMLDivElement, ItemProps | DivItemProps>(function ListItem({ as, ...rest }, ref) {
  const reduced = useReducedMotion()
  const motionProps = {
    layout: reduced ? false : ('position' as const),
    initial: { opacity: 0, scale: reduced ? 1 : 0.98 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: reduced ? 1 : 0.98 },
    transition: { ...springDefault, opacity: fadeTransition },
  }
  if (as === 'div') return <motion.div ref={ref} {...motionProps} {...(rest as HTMLMotionProps<'div'>)} />
  return <motion.li ref={ref} {...motionProps} {...(rest as HTMLMotionProps<'li'>)} />
})

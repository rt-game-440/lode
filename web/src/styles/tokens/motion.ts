/**
 * 弹簧参数（Apple 的 damping + response 模型映射到 motion 的 bounce + duration）。
 * - 默认临界阻尼、无过冲；
 * - 只有手势本身带动量（甩、拖拽松手）时才加一点回弹。
 * prefers-reduced-motion 由根部的 <MotionConfig reducedMotion="user"> 统一处理：位移和缩放跳过，透明度保留。
 */
import type { Transition } from 'motion/react'

/** 一般界面：面板切换、列表增删、保存状态变化。damping 1.0，response ~0.35s */
export const springDefault: Transition = { type: 'spring', bounce: 0, duration: 0.35 }

/** 小元素、快速反馈：弹出层、菜单。damping 1.0，response ~0.25s */
export const springSnappy: Transition = { type: 'spring', bounce: 0, duration: 0.25 }

/** 抽屉、底部面板（带动量的手势之后）。damping ~0.8，response ~0.3s */
export const springSheet: Transition = { type: 'spring', bounce: 0.15, duration: 0.3 }

/** reduced motion：短促的淡入淡出 */
export const fadeTransition: Transition = { duration: 0.18, ease: 'easeOut' }

/** 侧栏展开收起 */
export const springPanel: Transition = { type: 'spring', bounce: 0, duration: 0.4 }

# Lode 设计规范

界面以 Apple 原生应用的观感和手感为目标（参照 *Designing Fluid Interfaces*、*Principles of Great Design*）。本文是规则说明，**数值的唯一来源是 `web/src/styles/tokens/`**：

- `foundation.css`：字体、间距、圆角、阴影、材质、CSS 过渡时长、布局尺寸；
- `colors.css`：亮/暗两套颜色，以及高对比度、减弱透明度的覆盖规则；
- `motion.ts`：交互动画用的弹簧参数。

组件里不写颜色字面量和动画时长字面量。`src/styles/tokens.lint.test.ts` 会扫描 `src` 下除 tokens 以外的 css、ts、tsx 文件，发现十六进制颜色、`rgb()` / `hsl()`、CSS 的 `white` / `black`、`transition` / `animation` 里的时长，或 JS 里 `duration: 0.2` 这类写法，单测就会失败。新增数值时先加 token，再引用。

## 字体

- 字体栈：`--font-sans` 是系统字体栈，Apple 设备上会用到 San Francisco 和苹方，Windows 上是 Segoe UI 和微软雅黑；`--font-mono` 用于代码。不打包任何字体文件，符合 SPEC 的许可证要求。
- 字号层级参照 Apple 的文本样式：

  | token | 字号 | 用途 |
  | --- | --- | --- |
  | `--text-caption` | 12 | 角标、kbd |
  | `--text-footnote` | 13 | 次要信息、保存状态 |
  | `--text-subhead` | 14 | 侧栏、列表 |
  | `--text-callout` | 15 | |
  | `--text-body` | 16 | 界面正文 |
  | `--text-editor` | 17 | 编辑器正文 |
  | `--text-title3` 至 `--text-large-title` | 20–36 | 标题 |

- 行高随字号反向变化：大标题用 `--leading-tight`，正文用 `--leading-body`。
- 字距随字号变化：大字收紧（`--tracking-large`），小字略放（`--tracking-small`）。
- 层级靠字号、字重、行高一起建立。强调优先加字重，不靠加大字号。
- 尺寸一律用 rem，跟随用户的字号设置缩放。

## 间距与布局

- 4px 栅格：`--space-0-5` 至 `--space-16`。
- 触控最小可点区域为 `--hit-target`（44px）。在 `pointer: coarse` 设备上：
  - 列表行高 `--row-height`、输入框、手机工具栏按钮直接升到 44px；
  - 视觉上较小的按钮（`.btn`、`.icon-btn`、`.segment`，以及加了 `.hit-expand` 的元素）用透明的 `::after` 把可点区域扩到 44×44，外观和布局不变；
  - 正文里的任务复选框是行内控件（WCAG 2.5.8 的行内例外），只适当放大，不扩到 44px，以免盖住相邻行。
  - `e2e/visual.spec.ts` 的“手机上可点区域不小于 44×44”检查首页、编辑中的笔记、设置、回收站。
- 布局尺寸：顶栏 `--bar-height`、侧栏默认宽 `--sidebar-width`（可在 200–420 之间拖拽调整并记住）、右栏 `--rightbar-width`、手机编辑工具栏 `--toolbar-height`、编辑区最大宽度 `--editor-max-width`。
- 层级 z-index：顶栏 `--z-bar`、弹出层 `--z-popover`、模态 `--z-modal`、toast `--z-toast`。
- 安全区：顶栏、手机工具栏、抽屉、左缘手势区都加上 `env(safe-area-inset-*)`。
- 手机外壳高度跟随 `visualViewport`（`lib/viewport.ts` 写入 `--vv-height`、`--vv-top`、`--keyboard-inset`）。软键盘弹出时编辑区和工具栏一起缩到键盘上方，光标会重新滚入可见区域。

## 颜色

- 亮色和暗色默认跟随系统，`html[data-theme]` 可以手动覆盖。
- 背景分三层：窗口底色 `--color-bg-secondary`、内容 `--color-bg`、浮层 `--color-bg-elevated`。
- 文字分四级：`--color-label`、`-secondary`、`-tertiary`、`-quaternary`。前三级在对应背景上都达到 WCAG AA（≥ 4.5:1）；第四级只用于装饰，不承载信息。
- 强调色是 Apple 蓝的 AA 变体：
  - 文字、图标、焦点环用 `--color-accent`；
  - 按钮底色用 `--color-accent-fill`，上面的文字用 `--color-on-accent`。
- 状态色：`--color-danger`、`--color-success`、`--color-warning`。危险底色上的文字用 `--color-on-danger`。
- 高对比度（`prefers-contrast: more`）：次级文字提升为主文字色，分隔线加深，材质改为实色。

## 材质

- 侧栏、顶栏、手机编辑工具栏、菜单、快速切换器使用半透明背景加 `backdrop-filter`：
  - `--material-blur-regular` 用于顶栏和工具栏；
  - `--material-blur-thick` 用于侧栏和弹出层。面积越大越"厚"。
- 背景色分别是 `--color-bg-sidebar`、`--color-bg-bar`、`--color-bg-popover`。
- 不支持 `backdrop-filter`、开启"减弱透明度"或"提高对比度"时，这三个变量自动换成实色（见 `colors.css` 末尾），组件里不需要单独写兜底。
- 不在浅色毛玻璃上再叠浅色毛玻璃。
- 模态任务（对话框、快捷键一览、快速切换器）配遮罩 `--color-scrim`；不打断流程的面板（右栏抽屉）也配遮罩，但遮罩透明度跟随拖拽进度变化。

## 圆角与阴影

- 圆角：`--radius-xs`（4）到 `--radius-2xl`（22），胶囊形用 `--radius-full`。小元素用小圆角，大面板用大圆角。
- 阴影：表面越大越厚。按钮用 `--shadow-sm`，菜单用 `--shadow-md`，对话框、抽屉、手机详情页的边缘用 `--shadow-lg`。

## 图标

- 只用 lucide-react（ISC 许可证）。
- 尺寸：工具栏 18–20，列表 16，行内 14。线宽默认，文件树的展开箭头用 2.2。
- 纯图标按钮必须有 `aria-label`。`IconButton` 会把 label 同时用作无障碍名称和悬停提示。

## 动效

### 弹簧

可交互的动画一律用 `motion.ts` 里的弹簧。Apple 的参数是阻尼比 + response，对应 motion 的 `bounce` + `duration`：

| token | 阻尼 / response | 用于 |
| --- | --- | --- |
| `springDefault` | 1.0 / 0.35s | 面板切换、列表增删、保存状态、对话框 |
| `springSnappy` | 1.0 / 0.25s | 菜单、侧栏宽度回弹 |
| `springPanel` | 1.0 / 0.4s | 侧栏和右栏展开收起、导航栈进入 |
| `springSheet` | ≈0.8 / 0.3s | 手势松手后的抽屉、返回、工具栏滑入（带一点回弹） |
| `fadeTransition` | 0.18s 缓出 | 遮罩、reduced motion 下的替代动画 |
| `fadeOutQuick` | 0.12s 缓出 | 菜单关闭 |

默认临界阻尼、不过冲。只有手势本身带了动量（拖拽后松手）才用 `springSheet` 的轻微回弹。

CSS 过渡只用于 hover、颜色变化和按压反馈，时长取 `--duration-instant`、`--duration-fast`、`--duration-base`、`--duration-slow`，曲线取 `--ease-out`、`--ease-in-out`。

### 规则

- **只对 transform 和 opacity 做动画。** 例外只有下面两处，都是"主区域给侧栏让位"本身：
  - 桌面侧栏、右栏展开收起：各栏绝对定位，面板本身只改 transform；弹簧驱动的是展开进度，面板露出的宽度 = 进度 × 宽度，主区域的 `left` / `right` 逐帧贴住两侧面板的边缘（`panelMotion.ts`）。这样标题栏右侧的按钮每一帧都贴着右栏边缘、始终可见；正文列居中且有最大宽度，主区域比它宽时只平移、不换行，窄窗口里列宽跟着连续变化，没有开始或结束时的一次性跳变。主区域本身不加 transform，CodeMirror 的 fixed 定位提示框不会错位。需要沿侧栏边缘移动的元素读 `usePanelEdges()`。
  - 拖拽调整侧栏宽度：调宽本身就是改变布局，拖动时宽度逐帧跟手，越界松手的回弹和键盘步进用 `springSnappy` 直接改 width（`SidebarResizer.tsx`）。
  - `e2e/split-view.spec.ts` 逐帧检查：主区域贴着面板边缘、标题栏按钮每一帧可见、正文列单调移动且没有单帧跳变、中途反向、拖拽调宽、减弱动态效果。
- **可中断。** 动画都从当前值出发，手势或动画进行中反向操作会平滑转向。拖拽松手时把手势速度交给弹簧（motion value 自带速度）。
- **跟手。** 拖拽时元素 1:1 跟随手指，并保留按下时的偏移。越界时用 `rubberband` 阻力，不硬停。
- **按速度投射落点。** 松手时用 `project(v)` 估算惯性落点，再用 `shouldComplete` 判断完成还是弹回（`lib/gesture.ts`）。
- **方向先锁定。** 移动超过 10px 后再判断横向还是纵向（`lockAxis`），不抢滚动。锁定后从当前位置开始跟随，防抖的 10px 不计入位移，避免一开始跳一下。
- **系统取消不算松手。** `pointercancel`（系统接管了手势）时直接弹回，不按速度投射。
- **弹簧的选择看有没有动量。** 拖拽松手、快甩关闭用 `springSheet`；点按钮、按 Esc、点遮罩触发的同一个动画用 `springPanel`。
- **进出同路径。** 从哪里来就回到哪里去：抽屉从右边进、向右出；详情页从右边推入、向右滑出。
- **列表增删。** 用 `components/AnimatedList.tsx`：新增项淡入，删除项淡出并让出位置，其余项用弹簧平移。文件树超过 300 行时关闭这个动画，超过 2000 行时改用虚拟滚动。

### 减弱动态效果

- 根部设置了 `<MotionConfig reducedMotion="user">`。
- 手写的动画用 `useReducedMotion()` 判断：位移和缩放改为直接切换或淡入淡出，保留透明度变化。
- CSS 中 `--press-scale` 变为 1；加载指示器放慢到 `--duration-spin-reduced`。

## 反馈

| 类型 | 做法 |
| --- | --- |
| 按压 | 按下即缩放到 `--press-scale`（0.97），并加深底色 `--color-fill-strong` |
| 悬停 | 底色 `--color-fill`，过渡 `--duration-fast` |
| 焦点 | 只在键盘操作时显示焦点环（`:focus-visible`，`--color-focus-ring`） |
| 选中 | `--color-fill-selected` |
| 状态 | 顶栏的保存状态：编辑中 → 保存中 → 已保存，用弹簧上下交替；侧栏底部的同步状态点：同步中时呼吸闪烁 |
| 完成 | toast（成功）；破坏性操作可以撤销的不弹确认 |
| 警告 | 对话框，只用于不可撤销的破坏性操作（彻底删除、清空回收站、吊销 token） |
| 错误 | 危险色 toast；保存失败时状态变成可点击的"重试" |

## 交互与无障碍

- 所有功能都可以只用键盘完成。按 `?` 打开快捷键一览，设置页也有入口。快捷键列表在 `ShortcutsDialog.tsx`，与实际键位保持一致。
- 模态层（对话框、快捷键一览、抽屉）打开时，焦点移入层内，Tab 在层内循环；Esc 关闭；关闭后焦点回到打开前的元素（`useFocusTrap`）。
- 手机（宽度 < 768px）：
  - 单栏导航栈，从左缘右滑返回；
  - 右栏信息面板以可拖拽抽屉呈现；
  - 编辑时底部工具栏提供标题、列表、任务、链接、`[[`、图片。
- 平板（768–1100px）右栏用抽屉，桌面直接显示在主区域右侧。
- axe-core 扫描首启、登录、主界面、设置页的亮色和暗色，要求没有 serious / critical 级问题（`e2e/visual.spec.ts`）。

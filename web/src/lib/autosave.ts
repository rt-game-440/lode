export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface AutosaveOptions {
  /** 编辑停顿多久后保存（毫秒） */
  delay: number
  /** 执行保存；失败时抛错 */
  save: (content: string) => Promise<void>
  onStatus: (status: SaveStatus, error?: unknown) => void
  /** 正在用输入法组字时推迟保存 */
  isComposing?: () => boolean
}

/**
 * 自动保存：编辑停顿 delay 毫秒后保存；同一时间只有一个保存在进行，
 * 保存期间的新修改在上一次完成后接着保存。
 */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null
  private inflight: Promise<void> | null = null
  private disposed = false

  constructor(private opts: AutosaveOptions) {}

  /** 内容发生变化。 */
  change(content: string) {
    if (this.disposed) return
    this.pending = content
    this.opts.onStatus('dirty')
    this.schedule()
  }

  /** 是否有尚未保存的修改。 */
  get dirty(): boolean {
    return this.pending !== null || this.inflight !== null
  }

  /** 立即保存待保存的内容（例如切换笔记、页面隐藏时）。 */
  async flush(): Promise<void> {
    this.clearTimer()
    if (this.inflight) await this.inflight.catch(() => {})
    if (this.pending !== null) await this.run(true)
  }

  /** 不等停顿，尽快保存（正在组字时仍会推迟到组字结束）。 */
  kick() {
    if (this.disposed) return
    this.clearTimer()
    void this.run(false)
  }

  /** 丢弃尚未开始保存的修改，返回被丢弃的内容。 */
  reset(): string | null {
    const p = this.pending
    this.pending = null
    this.clearTimer()
    return p
  }

  dispose() {
    this.disposed = true
    this.clearTimer()
  }

  private schedule() {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(false)
    }, this.opts.delay)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async run(force: boolean): Promise<void> {
    if (this.pending === null) return
    if (!force && this.opts.isComposing?.()) {
      this.schedule()
      return
    }
    if (this.inflight) return // 当前保存完成后会继续
    const content = this.pending
    this.pending = null
    this.opts.onStatus('saving')
    const p = this.opts.save(content)
    this.inflight = p
    try {
      await p
      this.inflight = null
      if (this.pending !== null) {
        this.opts.onStatus('dirty')
        if (force) await this.run(true)
        else this.schedule()
      } else {
        this.opts.onStatus('saved')
      }
    } catch (err) {
      this.inflight = null
      if (this.pending === null) this.pending = content // 留待重试
      this.opts.onStatus('error', err)
    }
  }
}

import { create } from 'zustand'
import { ApiError, type WorkspaceApi, api, workspaceApi } from '../api/client'
import type { Change, Note, NoteContent, Tree } from '../api/types'
import { deviceId } from '../lib/device'
import { DEFAULT_WORKSPACE, apiPrefix, currentWorkspace, localDbName } from '../lib/workspace'
import { LocalDB, type QueueEntry } from './localdb'
import { rebase } from './textdiff'

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'conflict'

/** 一个冲突副本：path 的笔记与别处的修改冲突，一方的版本另存在 copyPath。 */
export interface ConflictInfo {
  path: string
  copyId: string
  copyPath: string
  /** 冲突副本是在其他设备上产生的 */
  remote: boolean
}

interface SyncState {
  status: SyncStatus
  /** 待同步的笔记数 */
  pending: number
  /** WebSocket 是否已连接 */
  connected: boolean
  conflicts: ConflictInfo[]
}

/** 同步状态，供界面展示。 */
export const useSync = create<SyncState>(() => ({ status: 'synced', pending: 0, connected: false, conflicts: [] }))

type Transport = Pick<WorkspaceApi, 'updateNote' | 'readNote' | 'createNote' | 'changes' | 'tree'>
/** 结构性操作（移动、删除、回收站、附件）用的接口，不经写队列 */
type Rest = Pick<
  WorkspaceApi,
  'moveNote' | 'deleteNote' | 'restore' | 'createFolder' | 'moveFolder' | 'deleteFolder' | 'purge' | 'emptyTrash' | 'uploadAttachment'
>

/** 同步引擎对外发出的事件，由各个 store 订阅。 */
export interface SyncEvents {
  /** 服务器确认了一次写入；result.content 与 sent 不同说明服务器做了三方合并 */
  applied: { id: string; sent: string; result: NoteContent }
  /** 写入与别处的修改冲突：服务器版本保持不变（server），本地版本已另存为冲突副本 */
  conflict: ConflictInfo & { id?: string; server?: NoteContent }
  /** 笔记已在别处删除，本地修改另存成了新笔记 */
  recovered: { id: string; note: NoteContent }
  /** 其他来源的变更（已过滤掉本机已经知道的版本） */
  remote: Change[]
  /** 增量记录已被服务器清理，需要全量重拉 */
  gone: undefined
}

type Listener<K extends keyof SyncEvents> = (e: SyncEvents[K]) => void | Promise<void>

/** 冲突副本的文件名：名称.conflict-<设备名>-<yyyyMMdd-HHmmss>.md */
export const CONFLICT_RE = /\.conflict-.+-\d{8}-\d{6}\.md$/i

export interface EngineOptions {
  /** 所属工作空间，决定 WebSocket 地址；默认是默认工作空间 */
  workspace?: string
  api?: Transport
  /** 结构性操作的接口；默认与 api 相同（api 是完整的 WorkspaceApi 时），否则用全局客户端 */
  rest?: Rest
  db?: LocalDB
  /** 浏览器是否认为自己在线；默认读 navigator.onLine */
  online?: () => boolean
  /** 判断一条变更本机是否已经知道（自己写入的回声），由笔记树 store 提供 */
  isKnown?: (c: Change) => boolean
}

/**
 * 同步引擎：前端读写笔记正文的唯一入口。
 *
 * - 写队列持久化在 IndexedDB，每篇笔记只保留最新正文；在线时立即发送，离线时留在队列里，
 *   联网（online 事件、WebSocket 重连）后按首次入队的顺序重放。
 * - 服务器对旧版本的写入做三方合并；若发送期间本地又有修改，用 rebase 把合并结果套到本地版本上。
 * - WebSocket 只推送变更通知，收到后用 /api/changes?since 补齐（410 时全量重拉，不动写队列）。
 */
export class SyncEngine {
  readonly workspace: string
  readonly db: LocalDB
  private api: Transport
  private rest: Rest
  private online: () => boolean
  isKnown: (c: Change) => boolean

  private queue = new Map<string, QueueEntry>()
  /** 本地修改的版本号：每次 save 加一，用来判断某次修改是否已被服务器处理（见 acked） */
  private ver = 0
  /** 入队顺序：同一篇笔记多次修改只保留首次入队的顺序，重放时按它排序 */
  private order = 0
  /** 每篇笔记最近一次被服务器处理（确认或冲突）的版本号 */
  private acked = new Map<string, number>()
  private failed = new Map<string, unknown>()
  private draining: Promise<void> | null = null
  private drainAgain = false
  private netDown = false
  private ready: Promise<void>
  private listeners: { [K in keyof SyncEvents]?: Listener<K>[] } = {}

  /** 本机已同步到的变更序号 */
  seq = 0
  /** 已从笔记树（服务器或缓存）拿到起点 seq；之前不补齐，避免从 0 拉取全部历史 */
  private haveSeq = false
  private catching: Promise<void> | null = null
  private catchAgain = false

  private started = false
  private ws: WebSocket | null = null
  private backoff = 1000
  private lastMessage = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 已被另一个工作空间的引擎取代：不再发事件、不再改 useSync */
  private disposed = false

  constructor(opts: EngineOptions = {}) {
    this.workspace = opts.workspace ?? DEFAULT_WORKSPACE
    this.api = opts.api ?? api
    this.rest = opts.rest ?? ('moveNote' in this.api ? (this.api as WorkspaceApi) : api)
    this.db = opts.db ?? new LocalDB()
    this.online = opts.online ?? (() => globalThis.navigator?.onLine ?? true)
    this.isKnown = opts.isKnown ?? (() => false)
    this.ready = this.db.queue().then((entries) => {
      for (const e of entries) {
        this.queue.set(e.id, e)
        this.ver = Math.max(this.ver, e.ver)
        this.order = Math.max(this.order, e.order)
      }
      this.publish()
    })
  }

  on<K extends keyof SyncEvents>(type: K, fn: Listener<K>): () => void {
    const list = (this.listeners[type] ??= []) as Listener<K>[]
    list.push(fn)
    return () => list.splice(list.indexOf(fn), 1)
  }

  private async emit<K extends keyof SyncEvents>(type: K, e: SyncEvents[K]) {
    if (this.disposed) return
    for (const fn of (this.listeners[type] ?? []) as Listener<K>[]) await fn(e)
  }

  /** 是否已被取代（切换到了别的工作空间）。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * 接管 prev 的订阅者和 isKnown（切换工作空间时，各个 store 在模块加载时注册的监听转到新引擎上）。
   * 两个引擎共用同一份监听列表，之前 on() 返回的取消函数仍然有效。
   */
  adopt(prev: SyncEngine) {
    this.listeners = prev.listeners
    this.isKnown = prev.isKnown
  }

  /**
   * 停用：断开 WebSocket、移除监听，之后不再发事件、不再更新同步状态。
   * 正在进行的发送照常完成并写进自己的 IndexedDB（写队列属于这个工作空间，切回来时继续补发），完成后关闭数据库连接。
   */
  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    void Promise.allSettled([this.draining, this.catching, this.ready]).then(() => this.db.close())
  }

  /** 等待写队列从 IndexedDB 载入完成。 */
  whenReady(): Promise<void> {
    return this.ready
  }

  /** 某篇笔记在队列里尚未同步的本地版本。 */
  pendingFor(id: string): QueueEntry | undefined {
    return this.queue.get(id)
  }

  // ---- 读取 ----

  /** 读取笔记正文。队列里有本地修改时以本地版本为准；离线时退回本地缓存。 */
  async readNote(id: string): Promise<{ doc: NoteContent; baseRev: number; fromCache: boolean }> {
    await this.ready
    try {
      const doc = await this.api.readNote(id)
      this.setNetDown(false)
      const e = this.queue.get(id)
      if (e) return { doc: { ...doc, content: e.content }, baseRev: e.baseRev, fromCache: false }
      void this.db.putNote(doc)
      return { doc, baseRev: doc.rev, fromCache: false }
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'network')) throw err
      this.setNetDown(true)
      const cached = await this.db.getNote(id)
      if (!cached) throw err
      const e = this.queue.get(id)
      return { doc: e ? { ...cached, content: e.content } : cached, baseRev: e?.baseRev ?? cached.rev, fromCache: true }
    }
  }

  /** 读取笔记树并缓存；离线时返回缓存的快照。 */
  async loadTree(): Promise<Tree & { fromCache: boolean }> {
    try {
      const t = await this.api.tree()
      this.setNetDown(false)
      // 以服务器快照的 seq 为准：数据目录重建后序号会变小，取较大值会导致之后每次补齐都 410。
      // 快照之后的变更会被重新补齐一次，应用变更是幂等的。
      this.seq = t.seq
      this.haveSeq = true
      void this.db.putTree({ folders: t.folders, notes: t.notes, seq: t.seq })
      return { ...t, fromCache: false }
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'network')) throw err
      this.setNetDown(true)
      const t = await this.db.getTree()
      if (!t) throw err
      this.seq = Math.max(this.seq, t.seq)
      this.haveSeq = true
      return { ...t, fromCache: true }
    }
  }

  /** 更新缓存的笔记树（本地增删改之后）。 */
  cacheTree(folders: string[], notes: Note[]) {
    void this.db.putTree({ folders, notes, seq: this.seq })
  }

  // ---- 写入 ----

  /**
   * 保存正文。baseRev 是 content 所基于的服务器版本（队列里已有本地修改时沿用队列里的 base）。
   * 返回 'synced' 表示服务器已处理，'queued' 表示暂存在本地队列等待联网。
   */
  async save(note: Pick<Note, 'id' | 'path'>, content: string, baseRev: number): Promise<'synced' | 'queued'> {
    await this.ready
    const prev = this.queue.get(note.id)
    const ver = ++this.ver
    const e: QueueEntry = prev
      ? { ...prev, path: note.path, content, ver }
      : { id: note.id, path: note.path, baseRev, content, ver, order: ++this.order }
    this.queue.set(note.id, e)
    this.failed.delete(note.id)
    await this.db.putEntry(e)
    const cached = await this.db.getNote(note.id)
    if (cached) await this.db.putNote({ ...cached, path: note.path, content })
    this.publish()
    await this.drain()
    if ((this.acked.get(note.id) ?? 0) >= ver) return 'synced'
    const err = this.failed.get(note.id)
    if (err) throw err
    return 'queued'
  }

  /** 把队列里的修改发给服务器（单飞：进行中时只标记再来一轮）。 */
  drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true
      return this.draining
    }
    this.draining = (async () => {
      do {
        this.drainAgain = false
        await this.drainOnce()
      } while (this.drainAgain && !this.netDown && this.online())
    })().finally(() => {
      this.draining = null
      this.publish()
    })
    this.publish()
    return this.draining
  }

  private async drainOnce() {
    const entries = [...this.queue.values()].sort((a, b) => a.order - b.order)
    for (const e of entries) {
      if (!this.online()) {
        this.setNetDown(true)
        return
      }
      const cur = this.queue.get(e.id)
      if (!cur) continue
      const snap = { ...cur }
      let res: NoteContent
      try {
        res = await this.api.updateNote(snap.id, snap.baseRev, snap.content)
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'network') {
            this.setNetDown(true)
            return
          }
          if (err.status === 401) return
          if (err.code === 'conflict') {
            await this.onConflict(snap, err)
            continue
          }
          if (err.status === 404) {
            await this.onMissing(snap)
            continue
          }
        }
        this.failed.set(snap.id, err)
        continue
      }
      this.setNetDown(false)
      await this.onSaved(snap, res)
    }
  }

  private async finish(id: string, ver: number) {
    this.acked.set(id, ver)
    this.failed.delete(id)
    const cur = this.queue.get(id)
    if (cur && cur.ver === ver) {
      this.queue.delete(id)
      await this.db.deleteEntry(id)
      return undefined
    }
    return cur
  }

  private async onSaved(snap: QueueEntry, res: NoteContent) {
    const newer = await this.finish(snap.id, snap.ver)
    let local = res.content
    if (newer) {
      // 发送期间本地又改了：新的修改基于刚确认的版本；服务器合并过时把合并结果套到本地版本上
      newer.baseRev = res.rev
      if (res.content !== snap.content) newer.content = rebase(snap.content, res.content, newer.content)
      local = newer.content
      await this.db.putEntry(newer)
    }
    await this.db.putNote({ ...res, merged: undefined, content: local })
    await this.emit('applied', { id: snap.id, sent: snap.content, result: res })
  }

  private async onConflict(snap: QueueEntry, err: ApiError) {
    const copyId = String(err.body.conflict_id ?? '')
    const copyPath = String(err.body.conflict_path ?? '')
    const newer = await this.finish(snap.id, snap.ver)
    if (newer) {
      // 发送后的本地修改也不能丢：经写队列写进冲突副本（rev 1），断网时留在队列里
      this.queue.delete(snap.id)
      await this.db.deleteEntry(snap.id)
      if (copyId) {
        const entry: QueueEntry = { id: copyId, path: copyPath, baseRev: 1, content: newer.content, ver: ++this.ver, order: ++this.order }
        this.queue.set(copyId, entry)
        await this.db.putEntry(entry)
        this.drainAgain = true
      }
    }
    let server: NoteContent | undefined
    try {
      server = await this.api.readNote(snap.id)
      await this.db.putNote(server)
    } catch {
      /* 稍后打开时再读 */
    }
    const info: ConflictInfo = { path: snap.path, copyId, copyPath, remote: false }
    if (copyId) this.addConflict(info)
    await this.emit('conflict', { ...info, id: snap.id, server })
  }

  private async onMissing(snap: QueueEntry) {
    const newer = await this.finish(snap.id, snap.ver)
    if (newer) {
      this.queue.delete(snap.id)
      await this.db.deleteEntry(snap.id)
    }
    try {
      const note = await this.api.createNote(snap.path, newer?.content ?? snap.content, true)
      await this.db.deleteNote(snap.id)
      await this.emit('recovered', { id: snap.id, note })
    } catch (err) {
      this.failed.set(snap.id, err)
    }
  }

  // ---- 结构性操作 ----
  // 新建、移动、删除等需要服务器分配 id 或改写链接，只能在线进行；离线时抛出 network 错误，由界面提示。
  // 除新建外都不经写队列，直接调用 REST 客户端（不在可注入的 Transport 里）。

  async createNote(path: string, content = '', autoRename = false): Promise<NoteContent> {
    const n = await this.api.createNote(path, content, autoRename)
    void this.db.putNote(n)
    return n
  }

  async moveNote(id: string, path: string) {
    const res = await this.rest.moveNote(id, path)
    const e = this.queue.get(id)
    if (e) {
      e.path = res.note.path
      await this.db.putEntry(e)
    }
    return res
  }

  /** 移到回收站；本地尚未同步的修改一并丢弃（回收站里保留的是服务器版本）。 */
  async deleteNote(id: string) {
    const item = await this.rest.deleteNote(id)
    this.queue.delete(id)
    await Promise.all([this.db.deleteEntry(id), this.db.deleteNote(id)])
    this.publish()
    return item
  }

  restoreNote = (id: string) => this.rest.restore(id)
  createFolder = (path: string) => this.rest.createFolder(path)
  moveFolder = (from: string, to: string) => this.rest.moveFolder(from, to)
  deleteFolder = (path: string) => this.rest.deleteFolder(path)
  purgeTrash = (id: string) => this.rest.purge(id)
  emptyTrash = () => this.rest.emptyTrash()
  uploadAttachment = (file: File | Blob, name?: string) => this.rest.uploadAttachment(file, name)

  // ---- 冲突列表 ----

  private addConflict(c: ConflictInfo) {
    if (this.disposed) return
    const list = useSync.getState().conflicts.filter((x) => x.copyId !== c.copyId)
    useSync.setState({ conflicts: [...list, c] })
    this.publish()
  }

  /** 用户已查看或忽略冲突副本。 */
  dismissConflict(copyId: string) {
    useSync.setState((s) => ({ conflicts: s.conflicts.filter((c) => c.copyId !== copyId) }))
    this.publish()
  }

  // ---- 增量同步 ----

  /** 用 /api/changes 补齐 seq 之后的变更（单飞）。 */
  catchUp(): Promise<void> {
    if (this.catching) {
      this.catchAgain = true
      return this.catching
    }
    this.catching = (async () => {
      do {
        this.catchAgain = false
        await this.catchUpOnce()
      } while (this.catchAgain)
    })().finally(() => {
      this.catching = null
    })
    return this.catching
  }

  private async catchUpOnce() {
    if (!this.haveSeq) return
    const foreign: Change[] = []
    for (;;) {
      let page: { changes: Change[]; seq: number }
      try {
        page = await this.api.changes(this.seq)
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) {
          // 记录已被清理：全量重拉笔记树（写队列保留，之后照常重放）
          await this.emit('gone', undefined)
          return
        }
        if (err instanceof ApiError && err.code === 'network') this.setNetDown(true)
        return
      }
      this.setNetDown(false)
      const { changes } = page
      for (const c of changes) if (!this.isKnown(c)) foreign.push(c)
      if (!changes.length) {
        this.seq = Math.max(this.seq, page.seq)
        break
      }
      this.seq = Math.max(this.seq, changes[changes.length - 1].seq)
      if (this.seq >= page.seq) break
    }
    if (!foreign.length) return
    const me = deviceId()
    for (const c of foreign) {
      // 冲突副本由服务器新建，首个版本 rev 为 1；之后有人编辑副本（rev > 1）不再算新冲突
      if (c.type === 'upsert' && c.device_id !== me && CONFLICT_RE.test(c.path) && c.rev === 1) {
        const info: ConflictInfo = { path: c.path.replace(CONFLICT_RE, '.md'), copyId: c.id, copyPath: c.path, remote: true }
        this.addConflict(info)
        await this.emit('conflict', info)
      }
    }
    await this.emit('remote', foreign)
  }

  // ---- 连接 ----

  /** 开始实时同步：连接 WebSocket、监听网络状态，并重放积压的写队列。 */
  start() {
    if (this.started || this.disposed || typeof window === 'undefined') return
    this.started = true
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    document.addEventListener('visibilitychange', this.onVisible)
    this.connect()
    // 兜底：队列里有失败或积压的项时定期重试；连接长时间没有消息（心跳 30s）时重连
    this.timers.push(
      setInterval(() => {
        if (this.queue.size && this.online()) void this.drain()
        if (this.ws && Date.now() - this.lastMessage > 75_000) this.ws.close()
      }, 10_000),
    )
    void this.ready.then(() => this.drain())
  }

  get isStarted(): boolean {
    return this.started
  }

  stop() {
    this.started = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline)
      window.removeEventListener('offline', this.onOffline)
      document.removeEventListener('visibilitychange', this.onVisible)
    }
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  private onOnline = () => {
    this.setNetDown(false)
    this.connect()
    void this.resync()
  }

  /** 重新联网或重连后：先补齐错过的变更（410 时全量重拉），再按顺序重放写队列。 */
  resync(): Promise<void> {
    return this.catchUp().then(() => this.drain())
  }

  private onOffline = () => {
    this.setNetDown(true)
  }

  private onVisible = () => {
    if (document.visibilityState !== 'visible') return
    if (!this.ws) this.connect()
    void this.catchUp()
  }

  private connect() {
    if (!this.started || this.ws || !this.online()) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + apiPrefix(this.workspace) + '/ws')
    this.ws = ws
    this.lastMessage = Date.now()
    ws.onopen = () => {
      if (this.disposed) return
      this.backoff = 1000
      useSync.setState({ connected: true })
      this.setNetDown(false)
    }
    ws.onmessage = (ev) => {
      if (this.disposed) return
      this.lastMessage = Date.now()
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; seq?: number }
        if (m.type === 'hello') void this.resync()
        else if (typeof m.seq === 'number' && m.seq > this.seq) void this.catchUp()
      } catch {
        /* 忽略无法解析的消息 */
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      if (this.disposed) return
      useSync.setState({ connected: false })
      if (!this.started) return
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 30_000)
    }
  }

  // ---- 状态 ----

  private setNetDown(down: boolean) {
    if (this.netDown === down) return
    this.netDown = down
    this.publish()
  }

  private publish() {
    if (this.disposed) return
    const pending = this.queue.size
    const conflicts = useSync.getState().conflicts
    const status: SyncStatus =
      this.netDown || !this.online()
        ? 'offline'
        : conflicts.length
          ? 'conflict'
          : this.draining || pending
            ? 'syncing'
            : 'synced'
    useSync.setState({ status, pending })
  }
}

/** 某个工作空间的同步引擎：IndexedDB 用 localDbName(ws)，接口和 WebSocket 固定在这个工作空间上。 */
export function createEngine(ws: string): SyncEngine {
  return new SyncEngine({ workspace: ws, api: workspaceApi(ws), db: new LocalDB(localDbName(ws)) })
}

/**
 * 当前工作空间的同步引擎。切换工作空间时整个换掉（见 switchSyncEngine）；
 * 这是 ES 模块的活绑定，其他模块里的 `sync` 总是指向当前的引擎，不要把它存进别的变量里长期使用。
 */
export let sync = createEngine(currentWorkspace())

/**
 * 换成 ws 的同步引擎：旧引擎停用（WebSocket 断开，写队列留在它自己的 IndexedDB 里），
 * 新引擎接管各个 store 的监听；旧引擎已经启动时新引擎也立即启动（连接 WebSocket、补发写队列）。
 */
export function switchSyncEngine(ws: string): SyncEngine {
  const prev = sync
  if (prev.workspace === ws && !prev.isDisposed) return prev
  const wasStarted = prev.isStarted
  const next = createEngine(ws)
  next.adopt(prev)
  prev.dispose()
  useSync.setState({ status: 'synced', pending: 0, connected: false, conflicts: [] })
  sync = next
  if (wasStarted) next.start()
  return next
}

import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import type { Change, NoteContent } from '../api/types'
import { SyncEngine, type SyncEvents, useSync } from './engine'
import { LocalDB } from './localdb'

let dbSeq = 0
const freshDB = () => new LocalDB(`test-${++dbSeq}`)

const doc = (id: string, rev: number, content: string, extra: Partial<NoteContent> = {}): NoteContent => ({
  id,
  path: `${id}.md`,
  title: id,
  rev,
  hash: '',
  size: content.length,
  mtime: 0,
  created_at: 0,
  updated_at: 0,
  content,
  ...extra,
})

/** 记录调用的假服务器：默认接受所有写入，rev = base + 1。 */
function fakeApi() {
  const calls: { id: string; base: number; content: string }[] = []
  const api = {
    calls,
    update: async (id: string, base: number, content: string): Promise<NoteContent> => doc(id, base + 1, content),
    updateNote(id: string, base: number, content: string) {
      calls.push({ id, base, content })
      return api.update(id, base, content)
    },
    readNote: async (id: string) => doc(id, 9, 'server'),
    createNote: async (path: string, content = '') => doc('new', 1, content, { path }),
    changes: async (_since: number): Promise<{ changes: Change[]; seq: number }> => ({ changes: [], seq: 0 }),
    tree: async () => ({ folders: [], notes: [], seq: 0 }),
  }
  return api
}

const change = (seq: number, id: string, rev: number, extra: Partial<Change> = {}): Change => ({
  seq,
  type: 'upsert',
  id,
  path: `${id}.md`,
  rev,
  device_id: 'other',
  device_name: '另一台',
  created_at: 0,
  ...extra,
})

/** 卡住第一次请求：entered 在请求到达服务器时完成，release 放行。 */
function gated() {
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const entered = new Promise<void>((r) => (enter = r))
  return { gate, entered, enter, release }
}

describe('SyncEngine 写队列', () => {
  it('离线时入队并持久化，联网后按顺序重放', async () => {
    const api = fakeApi()
    const db = freshDB()
    let online = false
    const a = new SyncEngine({ api, db, online: () => online })
    expect(await a.save({ id: 'n1', path: 'n1.md' }, '一', 1)).toBe('queued')
    expect(await a.save({ id: 'n2', path: 'n2.md' }, '二', 4)).toBe('queued')
    expect(await a.save({ id: 'n1', path: 'n1.md' }, '一一', 1)).toBe('queued')
    expect(useSync.getState()).toMatchObject({ status: 'offline', pending: 2 })
    expect(api.calls).toEqual([])

    // 页面重新打开：队列从 IndexedDB 恢复
    online = true
    const b = new SyncEngine({ api, db, online: () => online })
    await b.whenReady()
    await b.drain()
    expect(api.calls).toEqual([
      { id: 'n1', base: 1, content: '一一' },
      { id: 'n2', base: 4, content: '二' },
    ])
    expect(useSync.getState()).toMatchObject({ status: 'synced', pending: 0 })
    expect(await db.queue()).toEqual([])
  })

  it('服务器合并后，发送期间的本地修改会套到合并结果上再发送', async () => {
    const api = fakeApi()
    const e = new SyncEngine({ api, db: freshDB(), online: () => true })
    const g = gated()
    let first = true
    api.update = async (id, base, content) => {
      if (!first) return doc(id, base + 1, content)
      first = false
      g.enter()
      await g.gate
      // 另一台设备改了第一段，服务器合并后返回
      return doc(id, 3, '一 A\n\n二\n\n三 B\n', { merged: true })
    }
    const applied: SyncEvents['applied'][] = []
    e.on('applied', (x) => void applied.push(x))

    const p1 = e.save({ id: 'n', path: 'n.md' }, '一\n\n二\n\n三 B\n', 1)
    await g.entered
    const p2 = e.save({ id: 'n', path: 'n.md' }, '一\n\n二\n\n三 B\n四\n', 1)
    g.release()
    expect(await p1).toBe('synced')
    expect(await p2).toBe('synced')
    expect(api.calls[1]).toEqual({ id: 'n', base: 3, content: '一 A\n\n二\n\n三 B\n四\n' })
    expect(applied[0]).toMatchObject({ id: 'n', sent: '一\n\n二\n\n三 B\n', result: { content: '一 A\n\n二\n\n三 B\n', merged: true } })
  })

  it('冲突时移出队列、记录冲突副本并通知服务器版本', async () => {
    const api = fakeApi()
    api.update = async () => {
      throw new ApiError(409, 'conflict', '冲突', { current_rev: 2, conflict_id: 'c1', conflict_path: 'n.conflict-手机-20261107-160000.md' })
    }
    const e = new SyncEngine({ api, db: freshDB(), online: () => true })
    const events: SyncEvents['conflict'][] = []
    e.on('conflict', (x) => void events.push(x))
    expect(await e.save({ id: 'n', path: 'n.md' }, 'mine', 1)).toBe('synced')
    expect(e.pendingFor('n')).toBeUndefined()
    expect(events[0]).toMatchObject({ id: 'n', copyId: 'c1', copyPath: 'n.conflict-手机-20261107-160000.md', server: { content: 'server' } })
    expect(useSync.getState().conflicts.map((c) => c.copyId)).toContain('c1')
    expect(useSync.getState().status).toBe('conflict')
    e.dismissConflict('c1')
    expect(useSync.getState().status).toBe('synced')
  })

  it('冲突时发送期间的本地修改经写队列写进冲突副本，断网也不丢', async () => {
    const api = fakeApi()
    const g = gated()
    let copyDown = true
    api.update = async (id, base, content) => {
      if (id === 'c1') {
        if (copyDown) throw new ApiError(0, 'network', '网络不可用')
        return doc(id, base + 1, content)
      }
      g.enter()
      await g.gate
      throw new ApiError(409, 'conflict', '冲突', { current_rev: 2, conflict_id: 'c1', conflict_path: 'n.conflict-手机-20261107-160000.md' })
    }
    const e = new SyncEngine({ api, db: freshDB(), online: () => true })
    const p1 = e.save({ id: 'n', path: 'n.md' }, 'mine', 1)
    await g.entered
    const p2 = e.save({ id: 'n', path: 'n.md' }, 'mine 2', 1)
    g.release()
    await Promise.all([p1, p2])
    expect(e.pendingFor('n')).toBeUndefined()
    expect(e.pendingFor('c1')).toMatchObject({ path: 'n.conflict-手机-20261107-160000.md', baseRev: 1, content: 'mine 2' })

    copyDown = false
    await e.drain()
    expect(api.calls.at(-1)).toEqual({ id: 'c1', base: 1, content: 'mine 2' })
    expect(e.pendingFor('c1')).toBeUndefined()
    e.dismissConflict('c1')
  })

  it('笔记已在别处删除时把本地修改另存为新笔记', async () => {
    const api = fakeApi()
    api.update = async () => {
      throw new ApiError(404, 'not_found', '不存在')
    }
    const e = new SyncEngine({ api, db: freshDB(), online: () => true })
    const got: SyncEvents['recovered'][] = []
    e.on('recovered', (x) => void got.push(x))
    await e.save({ id: 'gone', path: '文件夹/旧.md' }, '本地内容', 3)
    expect(got[0]).toMatchObject({ id: 'gone', note: { path: '文件夹/旧.md', content: '本地内容' } })
    expect(e.pendingFor('gone')).toBeUndefined()
  })

  it('离线时读取笔记退回本地缓存，并带上未同步的修改', async () => {
    const api = fakeApi()
    let online = true
    const e = new SyncEngine({ api, db: freshDB(), online: () => online })
    expect((await e.readNote('n')).doc.content).toBe('server')
    online = false
    api.readNote = async () => {
      throw new ApiError(0, 'network', '网络不可用')
    }
    await e.save({ id: 'n', path: 'n.md' }, '离线修改', 9)
    const r = await e.readNote('n')
    expect(r).toMatchObject({ fromCache: true, baseRev: 9, doc: { content: '离线修改' } })
  })
})

describe('SyncEngine 增量同步', () => {
  it('过滤本机已知的变更，并推进 seq', async () => {
    const api = fakeApi()
    api.changes = async () => ({ changes: [change(1, 'a', 1), change(2, 'a', 2)], seq: 2 })
    const e = new SyncEngine({ api, db: freshDB(), isKnown: (c) => c.rev <= 1 })
    await e.loadTree()
    const remote: Change[][] = []
    e.on('remote', (cs) => void remote.push(cs))
    await e.catchUp()
    expect(remote).toEqual([[change(2, 'a', 2)]])
    expect(e.seq).toBe(2)
  })

  it('其他设备产生的冲突副本会加入冲突列表', async () => {
    const api = fakeApi()
    api.changes = async () => ({ changes: [change(5, 'cp', 1, { path: '日记/a.conflict-手机-20261107-160000.md' })], seq: 5 })
    const e = new SyncEngine({ api, db: freshDB() })
    await e.loadTree()
    await e.catchUp()
    expect(useSync.getState().conflicts).toContainEqual({
      path: '日记/a.md',
      copyId: 'cp',
      copyPath: '日记/a.conflict-手机-20261107-160000.md',
      remote: true,
    })
    e.dismissConflict('cp')
  })

  it('410 时通知全量重拉', async () => {
    const api = fakeApi()
    api.changes = async () => {
      throw new ApiError(410, 'gone', '已清理')
    }
    const e = new SyncEngine({ api, db: freshDB() })
    await e.loadTree()
    let gone = 0
    e.on('gone', () => void gone++)
    await e.catchUp()
    expect(gone).toBe(1)
  })

  it('还没拿到笔记树的 seq 时不补齐，避免从 0 拉取全部历史', async () => {
    const api = fakeApi()
    let asked = 0
    api.changes = async () => {
      asked++
      return { changes: [], seq: 0 }
    }
    const e = new SyncEngine({ api, db: freshDB() })
    await e.catchUp()
    expect(asked).toBe(0)
  })

  it('重连后先补齐变更（410 时等全量重拉完成），再按顺序重放写队列', async () => {
    const api = fakeApi()
    const log: string[] = []
    let online = false
    api.changes = async () => {
      log.push('changes')
      throw new ApiError(410, 'gone', '已清理')
    }
    const update = api.update
    api.update = async (id, base, content) => {
      log.push(`update ${id}`)
      return update(id, base, content)
    }
    const e = new SyncEngine({ api, db: freshDB(), online: () => online })
    await e.loadTree()
    e.on('gone', async () => {
      await new Promise((r) => setTimeout(r, 10))
      log.push('reloaded')
    })
    await e.save({ id: 'n1', path: 'n1.md' }, '离线一', 1)
    await e.save({ id: 'n2', path: 'n2.md' }, '离线二', 1)
    online = true
    await e.resync()
    expect(log).toEqual(['changes', 'reloaded', 'update n1', 'update n2'])
    expect(e.pendingFor('n1')).toBeUndefined()
  })
})

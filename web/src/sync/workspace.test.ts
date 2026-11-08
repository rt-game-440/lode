import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import type { Change, NoteContent } from '../api/types'
import { DEFAULT_WORKSPACE, localDbName } from '../lib/workspace'
import { SyncEngine, createEngine, switchSyncEngine, sync, useSync } from './engine'
import { LocalDB } from './localdb'

// 同步引擎按工作空间实例化（#58）：IndexedDB 各自独立，离线写队列切换后保留，停用的引擎不再发事件

const doc = (id: string, rev: number, content: string): NoteContent => ({
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
})

function fakeApi(online = true) {
  const calls: { id: string; base: number; content: string }[] = []
  return {
    calls,
    async updateNote(id: string, base: number, content: string) {
      if (!online) throw new ApiError(0, 'network', '网络不可用')
      calls.push({ id, base, content })
      return doc(id, base + 1, content)
    },
    readNote: async (id: string) => doc(id, 1, 'server'),
    createNote: async (path: string, content = '') => ({ ...doc('new', 1, content), path }),
    changes: async (): Promise<{ changes: Change[]; seq: number }> => ({ changes: [], seq: 0 }),
    tree: async () => ({ folders: [], notes: [], seq: 0 }),
  }
}

let seq = 0
const wsId = () => `t${(++seq).toString().padStart(5, '0')}`

afterAll(() => {
  switchSyncEngine(DEFAULT_WORKSPACE)
})

describe('按工作空间实例化同步引擎', () => {
  it('createEngine 用 lode / lode:<id> 作为 IndexedDB 名称', () => {
    const def = createEngine(DEFAULT_WORKSPACE)
    const other = createEngine('k3f9a2')
    expect(def.db.name).toBe('lode')
    expect(def.workspace).toBe(DEFAULT_WORKSPACE)
    expect(other.db.name).toBe('lode:k3f9a2')
    expect(other.workspace).toBe('k3f9a2')
    def.dispose()
    other.dispose()
  })

  it('A 离线时的写队列只在 A 的库里：切到 B 看不到，切回 A 后继续补发', async () => {
    const a = wsId()
    const b = wsId()
    const offline = fakeApi(false)
    const a1 = new SyncEngine({ workspace: a, api: offline, db: new LocalDB(localDbName(a)) })
    expect(await a1.save({ id: 'n1', path: 'n1.md' }, 'A 离线修改', 3)).toBe('queued')
    a1.dispose()

    const b1 = new SyncEngine({ workspace: b, api: fakeApi(), db: new LocalDB(localDbName(b)) })
    await b1.whenReady()
    expect(b1.pendingFor('n1')).toBeUndefined()
    b1.dispose()

    const online = fakeApi()
    const a2 = new SyncEngine({ workspace: a, api: online, db: new LocalDB(localDbName(a)) })
    await a2.whenReady()
    expect(a2.pendingFor('n1')).toMatchObject({ baseRev: 3, content: 'A 离线修改' })
    await a2.drain()
    expect(online.calls).toEqual([{ id: 'n1', base: 3, content: 'A 离线修改' }])
    expect(a2.pendingFor('n1')).toBeUndefined()
    a2.dispose()

    // 补发成功后队列清空，再打开 A 也没有积压
    const a3 = new SyncEngine({ workspace: a, api: fakeApi(), db: new LocalDB(localDbName(a)) })
    await a3.whenReady()
    expect(a3.pendingFor('n1')).toBeUndefined()
    a3.dispose()
  })

  it('新引擎接管订阅，停用的旧引擎不再发事件、不再改同步状态', async () => {
    const applied: string[] = []
    const old = new SyncEngine({ workspace: wsId(), api: fakeApi(), db: new LocalDB(`test-ws-${++seq}`) })
    old.on('applied', ({ result }) => void applied.push(result.content))
    old.isKnown = () => true
    const next = new SyncEngine({ workspace: wsId(), api: fakeApi(), db: new LocalDB(`test-ws-${++seq}`) })
    next.adopt(old)
    old.dispose()
    expect(old.isDisposed).toBe(true)
    expect(next.isKnown({} as Change)).toBe(true)

    await next.save({ id: 'x', path: 'x.md' }, '新引擎', 1)
    expect(applied).toEqual(['新引擎'])

    useSync.setState({ pending: 0 })
    await old.save({ id: 'y', path: 'y.md' }, '旧引擎', 1)
    expect(applied).toEqual(['新引擎'])
    expect(useSync.getState().pending).toBe(0)
    next.dispose()
  })

  it('switchSyncEngine 换掉当前引擎（活绑定）并重置同步状态', () => {
    const first = sync
    useSync.setState({ status: 'conflict', pending: 2, conflicts: [{ path: 'a.md', copyId: 'c', copyPath: 'a.conflict.md', remote: true }] })
    const next = switchSyncEngine('k3f9a2')
    expect(sync).toBe(next)
    expect(sync.workspace).toBe('k3f9a2')
    expect(sync.db.name).toBe('lode:k3f9a2')
    expect(first.isDisposed).toBe(true)
    expect(useSync.getState()).toMatchObject({ pending: 0, conflicts: [] })
    // 同一个工作空间不重复创建
    expect(switchSyncEngine('k3f9a2')).toBe(next)
    switchSyncEngine(DEFAULT_WORKSPACE)
    expect(sync.db.name).toBe('lode')
    expect(next.isDisposed).toBe(true)
  })
})

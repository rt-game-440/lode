import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type { Note, NoteContent } from '../api/types'

/** 写队列中的一项：某篇笔记尚未被服务器确认的最新正文。同一篇笔记只保留一项。 */
export interface QueueEntry {
  id: string
  path: string
  /** 本地修改所基于的服务器 rev */
  baseRev: number
  content: string
  /** 全局递增的版本号，每次本地修改都会变 */
  ver: number
  /** 首次入队的顺序，重放时按它排序 */
  order: number
}

/** 缓存的笔记树（离线冷启动时使用）。 */
export interface TreeSnapshot {
  folders: string[]
  notes: Note[]
  seq: number
}

interface Schema extends DBSchema {
  notes: { key: string; value: NoteContent }
  queue: { key: string; value: QueueEntry }
  meta: { key: string; value: unknown }
}

/**
 * 本地持久化：笔记树快照、打开过的笔记正文、写队列。IndexedDB 不可用时退化为内存。
 * 每个工作空间一个库（名称见 lib/workspace 的 localDbName），默认工作空间沿用 `lode`。
 */
export class LocalDB {
  private db: Promise<IDBPDatabase<Schema> | null>
  private mem = { notes: new Map<string, NoteContent>(), queue: new Map<string, QueueEntry>(), meta: new Map<string, unknown>() }

  constructor(readonly name = 'lode') {
    this.db =
      typeof indexedDB === 'undefined'
        ? Promise.resolve(null)
        : openDB<Schema>(name, 1, {
            upgrade(db) {
              db.createObjectStore('notes', { keyPath: 'id' })
              db.createObjectStore('queue', { keyPath: 'id' })
              db.createObjectStore('meta')
            },
          }).catch(() => null)
  }

  async getNote(id: string): Promise<NoteContent | undefined> {
    const db = await this.db
    return db ? db.get('notes', id) : this.mem.notes.get(id)
  }

  async putNote(n: NoteContent): Promise<void> {
    const db = await this.db
    if (db) await db.put('notes', n)
    else this.mem.notes.set(n.id, n)
  }

  async deleteNote(id: string): Promise<void> {
    const db = await this.db
    if (db) await db.delete('notes', id)
    else this.mem.notes.delete(id)
  }

  async cachedNoteIds(): Promise<string[]> {
    const db = await this.db
    return db ? db.getAllKeys('notes') : [...this.mem.notes.keys()]
  }

  async queue(): Promise<QueueEntry[]> {
    const db = await this.db
    const all = db ? await db.getAll('queue') : [...this.mem.queue.values()]
    return all.sort((a, b) => a.order - b.order)
  }

  async putEntry(e: QueueEntry): Promise<void> {
    const db = await this.db
    if (db) await db.put('queue', { ...e })
    else this.mem.queue.set(e.id, { ...e })
  }

  async deleteEntry(id: string): Promise<void> {
    const db = await this.db
    if (db) await db.delete('queue', id)
    else this.mem.queue.delete(id)
  }

  /** 清除缓存的笔记树和正文（退出登录时）；写队列里尚未同步的修改保留。 */
  async clearCache(): Promise<void> {
    const db = await this.db
    if (db) {
      await db.clear('notes')
      await db.clear('meta')
    } else {
      this.mem.notes.clear()
      this.mem.meta.clear()
    }
  }

  /** 关闭连接（切换工作空间后不再使用的库）；之后的读写退化为内存。 */
  async close(): Promise<void> {
    const db = await this.db
    this.db = Promise.resolve(null)
    db?.close()
  }

  async getTree(): Promise<TreeSnapshot | undefined> {
    const db = await this.db
    return (db ? await db.get('meta', 'tree') : this.mem.meta.get('tree')) as TreeSnapshot | undefined
  }

  async putTree(t: TreeSnapshot): Promise<void> {
    const db = await this.db
    if (db) await db.put('meta', t, 'tree')
    else this.mem.meta.set('tree', t)
  }
}

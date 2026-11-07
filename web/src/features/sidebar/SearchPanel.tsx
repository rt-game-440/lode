import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { SearchResult } from '../../api/types'
import { EmptyState, Spinner } from '../../components/ui'
import { dirname } from '../../lib/paths'
import { splitSnippet } from '../../lib/snippet'
import { useUI } from '../../stores/ui'
import { useVault } from '../../stores/vault'
import { errorMessage, openNote } from '../actions'

export function Highlighted({ text }: { text: string }) {
  return (
    <>
      {splitSnippet(text).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="search-hit">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

/** 全文搜索：输入停顿 200ms 后查询；vault 有变化时自动刷新结果。 */
export function SearchPanel({ autoFocus }: { autoFocus?: boolean }) {
  const [query, setQuery] = useState(() => sessionStorage.getItem('lode.search') ?? '')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const version = useVault((s) => s.version)
  const route = useUI((s) => s.route)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    sessionStorage.setItem('lode.search', query)
    const q = query.trim()
    if (!q) {
      setResults(null)
      setError(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const r = await api.search(q, 50)
        if (!cancelled) {
          setResults(r)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, version])

  const activeId = route.view === 'note' ? route.id : null

  return (
    <div className="search-panel">
      <div className="search-box">
        <Search size={15} className="search-icon" aria-hidden="true" />
        <input
          ref={input}
          type="search"
          className="search-input"
          placeholder="搜索全部笔记"
          aria-label="搜索全部笔记"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              ;(e.currentTarget.closest('.search-panel')?.querySelector('.search-result') as HTMLElement | null)?.focus()
            }
          }}
        />
        {busy ? (
          <Spinner size={14} />
        ) : (
          query && (
            <button className="search-clear" aria-label="清除搜索" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )
        )}
      </div>

      <div
        className="search-results"
        role="list"
        aria-label="搜索结果"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.search-result'))
          const i = items.indexOf(document.activeElement as HTMLElement)
          const next = e.key === 'ArrowDown' ? i + 1 : i - 1
          if (next < 0) input.current?.focus()
          else items[Math.min(next, items.length - 1)]?.focus()
        }}
      >
        {error && <p className="search-error">{error}</p>}
        {results && !results.length && !busy && <EmptyState title="没有找到结果">换个关键词试试</EmptyState>}
        {results?.map((r) => (
          <button
            key={r.id}
            role="listitem"
            className={`search-result${r.id === activeId ? ' is-active' : ''}`}
            onClick={() => openNote(r.id)}
          >
            <span className="search-result-title">{r.title}</span>
            {dirname(r.path) && <span className="search-result-path">{dirname(r.path)}</span>}
            {r.snippet && (
              <span className="search-result-snippet">
                <Highlighted text={r.snippet} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

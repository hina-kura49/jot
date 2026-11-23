import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { isComposing } from '@/lib/keyboard'
import { useApp } from '@/store/app'
import { findAgain, hideFind, search, useFind } from './find-store'

// ページの中を探す欄(⌘F)。本文の右上に重ねて出す。
// Enter / ⌘G で次へ、Shift+Enter / ⌘⇧G で前へ。Esc で閉じ、いまの当たりを選んだ状態で本文に戻る。

export function FindBar() {
  const { open, seq, query, current, total } = useFind()
  const pagePath = useApp((s) => s.page?.path)
  const inputRef = useRef<HTMLInputElement>(null)

  // 開いたら(⌘F をもう一度押したときも)、入力欄を選ぶ
  useLayoutEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, seq])

  // ページを切り替えたら閉じる
  const [lastPage, setLastPage] = useState(pagePath)
  if (pagePath !== lastPage) {
    setLastPage(pagePath)
    if (open) useFind.setState({ open: false, total: 0 })
  }

  if (!open) return null

  return (
    <div className="find-bar editor-popover pointer-events-auto ml-auto flex w-80 items-center gap-1 p-1" role="search" aria-label="ページの中を探す">
      <input
        ref={inputRef}
        value={query}
        placeholder="ページの中を探す"
        aria-label="ページの中を探す"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none"
        onChange={(e) => search(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e.nativeEvent)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            findAgain(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            hideFind(true)
          }
        }}
      />
      <span className="shrink-0 px-1 text-xs text-muted tabular-nums" aria-live="polite">
        {query ? (total > 0 ? `${current + 1} / ${total}` : '見つかりません') : ''}
      </span>
      <button type="button" title="前へ (⇧↩)" aria-label="前へ" className="hover-fade rounded-sm p-1 text-muted hover:bg-border/60" onClick={() => findAgain(-1)}>
        <ChevronUp size={15} />
      </button>
      <button type="button" title="次へ (↩)" aria-label="次へ" className="hover-fade rounded-sm p-1 text-muted hover:bg-border/60" onClick={() => findAgain(1)}>
        <ChevronDown size={15} />
      </button>
      <button type="button" title="閉じる (Esc)" aria-label="閉じる" className="hover-fade rounded-sm p-1 text-muted hover:bg-border/60" onClick={() => hideFind(false)}>
        <X size={15} />
      </button>
    </div>
  )
}

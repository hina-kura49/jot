import { Smile } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isComposing } from '@/lib/keyboard'
import { usePresence } from '@/lib/presence'
import { useApp } from '@/store/app'

/** 選べる絵文字(よく使うもの)。ここにないものは、入力欄に打つか貼り付ける */
const EMOJIS = [
  '📝', '📄', '📚', '📌', '📎', '🗂️', '📅', '✅',
  '💡', '🎯', '🚀', '⭐', '🔥', '✨', '🌱', '🌸',
  '🏠', '💼', '🏥', '💰', '📈', '🛒', '✈️', '🍽️',
  '🧪', '🛠️', '💻', '🔒', '🐛', '🧠', '🎨', '🎵',
  '❤️', '😀', '🤔', '👀', '🙏', '👍', '⚠️', '❓',
]

/** 入力欄の文字から、絵文字(書記素1つ)を取り出す。無ければ null */
function firstGrapheme(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)
  return first?.segment ?? null
}

/**
 * ページのアイコン(Notion と同じ)。タイトルの上に大きく出し、サイドバーとパンくずにも出す。
 * 保存先は Markdown の先頭のフロントマターの `icon:`(lib/frontmatter.ts)。
 * アイコンがないときは、ページの上にマウスを乗せると「アイコンを追加」が出る。
 */
export function PageIcon({ path, icon }: { path: string; icon: string | null }) {
  const setPageIcon = useApp((s) => s.setPageIcon)
  const [open, setOpen] = useState(false)
  const choose = (next: string | null) => {
    setPageIcon(path, next)
    setOpen(false)
  }

  return (
    <div className="page-icon no-print relative">
      {icon ? (
        <button type="button" className="page-icon-emoji hover-fade rounded-md hover:bg-border/60" title="アイコンを変更" onClick={() => setOpen(true)}>
          {icon}
        </button>
      ) : (
        <button
          type="button"
          className="page-icon-add hover-fade flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-sm text-muted hover:bg-border/60"
          onClick={() => setOpen(true)}
        >
          <Smile size={15} />
          アイコンを追加
        </button>
      )}
      <IconPicker open={open} hasIcon={icon !== null} onChoose={choose} onClose={() => setOpen(false)} />
    </div>
  )
}

function IconPicker({ open, hasIcon, onChoose, onClose }: { open: boolean; hasIcon: boolean; onChoose: (icon: string | null) => void; onClose: () => void }) {
  const { mounted, ref } = usePresence<HTMLDivElement>(open, 'menu')
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  // 開き直したら、入力欄を空にする
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setText('')
  }

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, onClose, ref])

  if (!mounted) return null
  const typed = firstGrapheme(text)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="アイコンを選ぶ"
      className="editor-popover absolute top-full left-0 z-40 mt-1 w-[19rem] p-2"
      style={{ transformOrigin: 'top left' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="mb-2 flex gap-1.5">
        <input
          ref={inputRef}
          value={text}
          placeholder="絵文字を入力・貼り付け"
          aria-label="絵文字を入力・貼り付け"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-focus"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isComposing(e.nativeEvent) || e.key !== 'Enter') return
            e.preventDefault()
            if (typed) onChoose(typed)
          }}
        />
        {hasIcon && (
          <button type="button" className="hover-fade rounded-sm px-2 text-sm text-muted hover:bg-border/60" onClick={() => onChoose(null)}>
            削除
          </button>
        )}
      </div>
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            className="hover-fade flex aspect-square items-center justify-center rounded-sm text-xl hover:bg-border/60"
            onClick={() => onChoose(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}

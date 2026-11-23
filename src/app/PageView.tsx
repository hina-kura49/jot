import { ChevronsRight, File, FileX, Search, Share } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { MarkdownEditor } from '@/editor/MarkdownEditor'
import { focusEditorAtEnd } from '@/editor/registry'
import { cn } from '@/lib/cn'
import { isTauri } from '@/lib/platform'
import { duration, easing, exitRatio, fadeIn, slideFrom } from '@/lib/motion'
import { ancestorsOf, countPages, isPage, useApp, type OpenPage } from '@/store/app'
import { EmptyState } from './EmptyState'
import { ContextMenu } from './ContextMenu'
import { exportHtml } from './export-html'
import { exportPdf } from './export-pdf'
import { openPalette } from './palette-store'
import { FindBar } from './FindBar'
import { NoticeBar } from './NoticeBar'
import { PageIcon } from './PageIcon'
import { PageTitle } from './PageTitle'

type ReadablePage = Extract<OpenPage, { content: string }>

export function PageView() {
  const page = useApp((s) => s.page)
  const tree = useApp((s) => s.tree)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const openPage = useApp((s) => s.openPage)
  const [shareAt, setShareAt] = useState<{ x: number; y: number } | null>(null)
  const revealFolder = useApp((s) => s.revealFolder)
  const noPages = !page && countPages(tree) === 0
  const trail = page ? ancestorsOf(tree, page.path) : []
  const title = trail.at(-1)?.title ?? ''
  const icon = trail.at(-1)?.icon ?? null
  // 開けないページのときもエディタは片づけず(作り直すと次の表示が遅れる)、直前に開けたページのまま隠しておく
  const [editorPage, setEditorPage] = useState<ReadablePage | null>(null)
  if (page && !page.unreadable && page !== editorPage) setEditorPage(page)
  // エディタが最初の文書を表示できるまで、タイトルも含めて何も出さない
  const [ready, setReady] = useState(false)
  const onReady = useCallback(() => setReady(true), [])
  const mainRef = useSidebarMotion(sidebarCollapsed)
  const articleRef = usePageEnter(ready ? (editorPage?.path ?? null) : null, editorPage?.renamed ?? false)

  return (
    <main ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-panel">
      {/* サイドバーを閉じているときは、macOS の信号機ボタンの分だけ左を空ける */}
      <header
        data-tauri-drag-region
        data-follow-sidebar
        className={cn('no-print flex h-12 shrink-0 items-center gap-2 pr-4 text-sm text-muted', isTauri && sidebarCollapsed ? 'pl-20' : 'pl-4')}
      >
        {sidebarCollapsed && (
          <button type="button" onClick={toggleSidebar} title="サイドバーを開く (⌘\)" className="hover-fade rounded-sm p-1 hover:bg-border/60">
            <ChevronsRight size={16} />
          </button>
        )}
        <nav aria-label="パンくずリスト" className="flex-1 truncate">
          {trail.map((n, i) => (
            <span key={n.path}>
              {i > 0 && <span className="mx-1.5">/</span>}
              {/* ページなら開き、フォルダならサイドバーでその場所を開いて見せる */}
              <button
                type="button"
                onClick={() => (isPage(n) ? void openPage(n.path) : revealFolder(n.path))}
                className={cn('rounded-sm px-0.5 hover:bg-border/60 hover:text-text', i === trail.length - 1 && 'text-text')}
              >
                {n.icon && <span className="mr-1">{n.icon}</span>}
                {n.title}
              </button>
            </span>
          ))}
        </nav>
        {/* 検索窓。押すとコマンドパレット(⌘K)を開き、そのまま打てる */}
        <button
          type="button"
          onClick={openPalette}
          className="search-field hover-fade flex h-7 w-56 shrink items-center gap-2 rounded-sm border border-border bg-bg px-2 text-left text-muted hover:border-focus/40"
        >
          <Search size={14} className="shrink-0" />
          <span className="flex-1 truncate">ページと本文を検索</span>
          <kbd className="shrink-0 font-sans text-xs">⌘K</kbd>
        </button>
        {page && !page.unreadable && (
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setShareAt({ x: r.right - 208, y: r.bottom + 4 })
            }}
            title="共有・書き出し"
            aria-haspopup="menu"
            className="hover-fade rounded-sm p-1 hover:bg-border/60"
          >
            <Share size={16} />
          </button>
        )}
        <ContextMenu
          at={shareAt}
          onClose={() => setShareAt(null)}
          items={[
            { label: 'HTML に書き出す(共有用)', keys: '⌘⇧H', run: () => void exportHtml() },
            { label: 'PDF に書き出す', keys: '⌘⇧E', run: () => void exportPdf(title) },
          ]}
        />
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto" onMouseDown={clickBelowContent}>
        {/* 通知は本文の上に重ねる(出ても本文の位置を動かさない) */}
        <div className="no-print sticky top-0 z-10 h-0 overflow-visible px-6 pt-2">
          <NoticeBar />
        </div>
        {/* ページの中を探す欄(⌘F)。本文の右上に重ねる */}
        <div className="no-print pointer-events-none sticky top-0 z-20 flex h-0 overflow-visible px-4 pt-2" onMouseDown={(e) => e.stopPropagation()}>
          <FindBar />
        </div>
        {noPages && <NoPages />}
        {page?.unreadable && (
          <EmptyState icon={<FileX size={44} strokeWidth={1.25} />} title="このファイルは開けません">
            文字コードが UTF-8 ではないため、表示も編集もできません。
          </EmptyState>
        )}
        {editorPage && (
          <article
            ref={articleRef}
            data-follow-sidebar
            className="page"
            style={{ visibility: ready ? 'visible' : 'hidden', display: page && !page.unreadable ? undefined : 'none' }}
          >
            {ready && <PageIcon path={editorPage.path} icon={icon} />}
            <PageTitle path={editorPage.path} title={title} visible={ready} />
            <MarkdownEditor
              path={editorPage.path}
              loadId={editorPage.loadId}
              content={editorPage.content}
              version={editorPage.version}
              onReady={onReady}
            />
          </article>
        )}
      </div>
    </main>
  )
}

/** 本文より下の空白を押したら、本文の末尾に入力位置を置く(Notion と同じ)。本文やタイトル、ボタンなどを押したときは何もしない */
function clickBelowContent(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  const blank = target === e.currentTarget || target.matches('article.page, .editor-host, .jot-editor')
  const body = e.currentTarget.querySelector('.jot-editor .ProseMirror')
  if (!blank || !body || e.clientY <= body.getBoundingClientRect().bottom) return
  // 押した瞬間にフォーカスが外れないようにする
  e.preventDefault()
  focusEditorAtEnd()
}

/** ページが1つもない(デザイン 6) */
function NoPages() {
  const newPage = useApp((s) => s.newPage)
  return (
    <EmptyState
      icon={<File size={44} strokeWidth={1.25} />}
      title="まだページがありません"
      action={
        <button
          type="button"
          autoFocus
          onClick={() => void newPage('sibling')}
          className="hover-fade rounded-md border border-border bg-panel px-4 py-2 text-sm hover:bg-bg"
        >
          新規ページを作成
        </button>
      }
    >
      最初のページを作成して、
      <br />
      思考を書き留めましょう。
    </EmptyState>
  )
}

/**
 * ページを切り替えたら、本文を短いフェードとわずかな浮き上がりで見せる(Notion のような切り替わり)。
 * 最初の表示と、同じページの読み直しでは動かさない。
 */
function usePageEnter(path: string | null, renamed: boolean) {
  const ref = useRef<HTMLElement>(null)
  const shown = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || path === null || path === shown.current) return
    const first = shown.current === null
    shown.current = path
    // 名前が変わっただけ(改名・移動)なら、同じページなので動かさない
    if (!first && !renamed) fadeIn(el, { duration: duration('page'), offsetY: 6 })
  }, [path, renamed])
  return ref
}

/**
 * サイドバーの開閉に本文を追従させる。本文の幅を毎フレーム変えるとレイアウトの再計算が続くので、
 * 左の余白は一度に切り替え、パンくずと本文の見た目の位置だけを元の位置から滑らせる(transform)。
 * 動いている最中に再び開閉しても、今の位置から続けて動く。
 */
function useSidebarMotion(collapsed: boolean) {
  const mainRef = useRef<HTMLElement>(null)
  const first = useRef(true)
  useLayoutEffect(() => {
    const main = mainRef.current
    if (!main) return
    const margin = collapsed ? '0px' : 'var(--sidebar-width)'
    if (first.current) {
      first.current = false
      main.style.marginLeft = margin
      return
    }
    const targets = Array.from(main.querySelectorAll<HTMLElement>('[data-follow-sidebar]'))
    const before = targets.map((el) => el.getBoundingClientRect())
    main.style.marginLeft = margin
    // 閉じる(出る)動きは、開く(入る)動きより短く
    const ms = duration('sidebar') * (collapsed ? exitRatio() : 1)
    targets.forEach((el, i) => slideFrom(el, before[i], { duration: ms, easing: easing(collapsed ? 'exit' : 'enter'), axis: 'x' }))
  }, [collapsed])
  return mainRef
}

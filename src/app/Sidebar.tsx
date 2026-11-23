import { ChevronRight, ChevronsLeft, CircleArrowDown, FileText, Folder, FolderOpen, FolderPlus, Plus } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TreeNode } from '@/backend'
import { cn } from '@/lib/cn'
import { flipRows } from '@/lib/flip-rows'
import { movedPath, remapPath } from '@/store/tree-move'
import { isComposing, modPressed } from '@/lib/keyboard'
import { ancestorsOf, isPage, useApp } from '@/store/app'
import { openPalette } from './palette-store'
import { isTauri } from '@/lib/platform'
import { applySidebarWidth, SIDEBAR_DEFAULT } from '@/lib/sidebar-width'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { dropTargetAt, isPrimaryButtonHeld, isSamePlace, movedEnoughToDrag, type DropTarget } from './tree-drag'
import { JotMark } from './JotMark'

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const newPage = useApp((s) => s.newPage)
  const newFolder = useApp((s) => s.newFolder)
  const openInbox = useApp((s) => s.openInbox)
  const [notesOpen, setNotesOpen] = useState(true)

  return (
    <aside
      className="sidebar absolute inset-y-0 left-0 z-10 flex w-[var(--sidebar-width)] flex-col border-r border-border bg-bg"
      data-collapsed={collapsed}
      inert={collapsed}
      aria-hidden={collapsed}
    >
      {/* macOS の信号機ボタン(Tauri の titleBarStyle: Overlay で表示される)の分だけ空ける */}
      <div data-tauri-drag-region className={cn('flex h-12 items-center gap-2 pr-2', isTauri ? 'pl-20' : 'pl-4')}>
        <span data-tauri-drag-region className="flex flex-1 items-center gap-2 truncate text-base font-bold tracking-[0.2em]">
          <JotMark />
          JOT
        </span>
        <button
          type="button"
          onClick={toggleSidebar}
          title="サイドバーを閉じる (⌘\)"
          className="hover-fade rounded-sm p-1 text-muted hover:bg-border/60"
        >
          <ChevronsLeft size={16} />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 pt-1">
        <NavItem icon={<FileText size={16} />} label="すべてのページ" title="ページを探す (⌘K)" onClick={openPalette} />
        <NavItem icon={<CircleArrowDown size={16} />} label="クイックキャプチャ" title="Inbox を開く" onClick={() => void openInbox()} />
      </nav>

      <button
        type="button"
        onClick={() => setNotesOpen((v) => !v)}
        aria-expanded={notesOpen}
        className="hover-fade mx-2 mt-5 flex items-center rounded-sm px-2 py-1 text-sm text-muted hover:bg-border/60"
      >
        <span className="label flex-1 text-left">ノート</span>
        <ChevronRight size={14} className="chevron" data-open={notesOpen} />
      </button>

      {notesOpen ? <Tree /> : <div className="flex-1" />}

      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <button
          type="button"
          title="新規ページ (⌘N)"
          className="hover-fade flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-base text-muted hover:bg-border/60"
          onClick={() => void newPage('sibling')}
        >
          <Plus size={16} />
          新規ページ
        </button>
        <button
          type="button"
          title="新規フォルダ"
          aria-label="新規フォルダ"
          className="hover-fade rounded-sm p-1.5 text-muted hover:bg-border/60"
          onClick={() => void newFolder(null)}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <ResizeHandle />
    </aside>
  )
}

/**
 * サイドバーの右端のつまみ。ドラッグで幅を変え、ダブルクリックで既定の幅に戻す。
 * ドラッグ中は、サイドバーと本文の動き(transition)を止め、ポインタに遅れずについていく。
 */
function ResizeHandle() {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const left = handle.parentElement?.getBoundingClientRect().left ?? 0
    document.body.classList.add('sidebar-resizing')
    let width = 0
    const onMove = (ev: PointerEvent) => {
      width = applySidebarWidth(ev.clientX - left)
    }
    const onUp = () => {
      document.body.classList.remove('sidebar-resizing')
      if (width) applySidebarWidth(width, true)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="サイドバーの幅"
      title="ドラッグで幅を変える(ダブルクリックで元に戻す)"
      className="sidebar-resize absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
      onPointerDown={onPointerDown}
      onDoubleClick={() => applySidebarWidth(SIDEBAR_DEFAULT, true)}
    />
  )
}

function NavItem({ icon, label, title, onClick }: { icon: React.ReactNode; label: string; title?: string; onClick?: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick} className="hover-fade flex items-center gap-2 rounded-sm px-2 py-1.5 text-base hover:bg-border/60">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  )
}

type Row = { node: TreeNode; depth: number; open: boolean; parent: string | null }

/** 開いているフォルダだけをたどって、表示する行の一覧にする */
function flatten(nodes: TreeNode[], expanded: Set<string>, depth = 0, parent: string | null = null, out: Row[] = []): Row[] {
  for (const node of nodes) {
    const open = expanded.has(node.path)
    out.push({ node, depth, open, parent })
    if (open && node.children.length > 0) flatten(node.children, expanded, depth + 1, node.path, out)
  }
  return out
}

const ROW_HEIGHT = 28
/** 閉じた行に重ねたまま、これだけ待つと開く */
const EXPAND_DELAY_MS = 600
/** ツリーの上端・下端からこの距離に入ると、自動でスクロールする */
const SCROLL_EDGE = 28

/**
 * 行をつかんで別の場所へ動かす(tree-drag.ts)。マウスを押しただけではつかまず、少し動かしてから始める。
 * Esc でやめる。閉じた行に重ねて待つと開き、ツリーの端に寄せるとスクロールする。
 */
function useTreeDrag(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  rows: Row[],
  tree: TreeNode[],
  expand: (path: string) => void,
  move: (path: string, parent: string | null) => void,
) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null)
  const clickBlocked = useRef(false)
  // 最新の値を、押している間のイベントから読む
  const latest = useRef({ rows, tree, expand, move })
  useLayoutEffect(() => {
    latest.current = { rows, tree, expand, move }
  })

  const press = (row: Row, down: React.MouseEvent) => {
    const start = { x: down.clientX, y: down.clientY }
    let started = false
    let pointer = start
    let current: DropTarget | null = null
    let expandTimer: ReturnType<typeof setTimeout> | undefined
    let expandFor: string | null = null
    let frame = 0

    const update = () => {
      const scroller = scrollRef.current
      if (!scroller) return
      const el = document.elementFromPoint(pointer.x, pointer.y)
      const li = el?.closest<HTMLElement>('[data-row]')
      const inTree = !!el && scroller.contains(el)
      const hovered = li ? latest.current.rows.find((r) => r.node.path === li.dataset.row) : undefined
      let next: DropTarget | null = null
      if (hovered && li) {
        const rect = li.getBoundingClientRect()
        next = dropTargetAt(latest.current.tree, row.node.path, { path: hovered.node.path, parent: hovered.parent }, (pointer.y - rect.top) / rect.height)
      } else if (inTree) {
        next = dropTargetAt(latest.current.tree, row.node.path, null, 0)
      }
      // いまと同じ場所は、落としても何も起きないので示さない
      if (next && isSamePlace(next, row.parent)) next = null
      current = next
      setTarget(next)
      // 閉じた行に重ねて待つと開く
      const closed = next?.mode === 'into' && hovered && !hovered.open && hovered.node.children.length > 0 ? hovered.node.path : null
      if (closed !== expandFor) {
        clearTimeout(expandTimer)
        expandFor = closed
        if (closed) expandTimer = setTimeout(() => latest.current.expand(closed), EXPAND_DELAY_MS)
      }
    }

    // ツリーの端に寄せている間はスクロールし続ける
    const autoScroll = () => {
      const scroller = scrollRef.current
      if (scroller) {
        const rect = scroller.getBoundingClientRect()
        const speed =
          pointer.y < rect.top + SCROLL_EDGE ? -(rect.top + SCROLL_EDGE - pointer.y) / 3 : pointer.y > rect.bottom - SCROLL_EDGE ? (pointer.y - rect.bottom + SCROLL_EDGE) / 3 : 0
        if (speed !== 0) {
          scroller.scrollTop += speed
          update()
        }
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (e: MouseEvent) => {
      // 離した合図を取りこぼしていたら、動かさずにやめる
      if (!isPrimaryButtonHeld(e.buttons)) {
        finish(false)
        return
      }
      pointer = { x: e.clientX, y: e.clientY }
      if (!started) {
        if (!movedEnoughToDrag(start, pointer)) return
        started = true
        setDragging(row.node.path)
        document.body.classList.add('tree-dragging')
        frame = requestAnimationFrame(autoScroll)
      }
      setGhost({ ...pointer, title: row.node.title })
      update()
    }

    const finish = (drop: boolean) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      clearTimeout(expandTimer)
      cancelAnimationFrame(frame)
      document.body.classList.remove('tree-dragging')
      setDragging(null)
      setTarget(null)
      setGhost(null)
      if (!started) return
      // 離した直後に届くクリックだけを止める(別の行の上で離すとクリックは届かないので、すぐ戻す)
      clickBlocked.current = true
      setTimeout(() => (clickBlocked.current = false), 0)
      if (drop && current) latest.current.move(row.node.path, current.parent)
    }
    const onUp = () => finish(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !started) return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    // 別のアプリへ移ったら、つかんだままにしない
    const onBlur = () => finish(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
  }

  /** つかんで動かした直後のクリックなら true を返し、そのクリックを使い切る */
  const consumeClick = () => {
    const blocked = clickBlocked.current
    clickBlocked.current = false
    return blocked
  }

  // 「同じ場所に並べる」ときの線。重ねた行の上か下に、その行の深さから引く
  let line: { top: number; left: number } | null = null
  if (target?.mode === 'beside') {
    const index = rows.findIndex((r) => r.node.path === target.row)
    if (index >= 0) line = { top: (index + (target.after ? 1 : 0)) * ROW_HEIGHT - 1, left: 4 + rows[index].depth * 14 }
  }

  return { press, consumeClick, dragging, target, ghost, line }
}

/**
 * ノートのツリー。数百項目でも軽く開閉できるよう、見えている行だけを描く(TanStack Virtual)。
 * 行の位置は top で決め、開閉の動き(flipRows)には transform を使う。
 *
 * キーボード: ツリー全体に入力位置を置き、いまの行を aria-activedescendant で示す(描かれていない行へも移れる)。
 *   ↑↓ 移動 / → 開く・子へ / ← 閉じる・親へ / Enter・Space 開く / Home・End / ⌘⌫ 削除 / Shift+F10 メニュー
 */
function Tree() {
  // スクロール領域はツリー自身が持つ(親の ref は子の初回計測に間に合わないため)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tree = useApp((s) => s.tree)
  const selectedPath = useApp((s) => s.selectedPath)
  const reveal = useApp((s) => s.reveal)
  const openPage = useApp((s) => s.openPage)
  const prefetch = useApp((s) => s.prefetch)
  const newPage = useApp((s) => s.newPage)
  const requestDelete = useApp((s) => s.requestDelete)
  const focusTitle = useApp((s) => s.focusTitle)
  const newFolder = useApp((s) => s.newFolder)
  const renamingFolder = useApp((s) => s.renamingFolder)
  const setRenamingFolder = useApp((s) => s.setRenamingFolder)
  const renameFolder = useApp((s) => s.renameFolder)
  const moveEntry = useApp((s) => s.moveEntry)

  // 最上位のフォルダと、選択中のページの祖先は最初から開いておく
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set(tree.map((n) => n.path))
    if (selectedPath) for (const a of ancestorsOf(tree, selectedPath)) set.add(a.path)
    return set
  })
  const rows = useMemo(() => flatten(tree, expanded), [tree, expanded])
  const [active, setActive] = useState<string | null>(selectedPath)
  const activeIndex = Math.max(0, rows.findIndex((r) => r.node.path === active))
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; row: Row } | null>(null)

  // React Compiler は使っていないので、メモ化できない API でも問題ない
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows[i].node.path,
    overscan: 8,
  })

  const setOpen = useCallback(
    (path: string, open: boolean) =>
      flipRows(scrollRef.current, () =>
        setExpanded((prev) => {
          if (prev.has(path) === open) return prev
          const next = new Set(prev)
          if (open) next.add(path)
          else next.delete(path)
          return next
        }),
      ),
    [],
  )

  // ページを開いたら、そのページの行を見せる(祖先を開き、スクロールする)
  const [pendingScroll, setPendingScroll] = useState<string | null>(null)
  const [lastReveal, setLastReveal] = useState(reveal)
  if (reveal && reveal !== lastReveal) {
    setLastReveal(reveal)
    // expand のときは、その行自身も開く(パンくずでフォルダを選んだとき)
    const ancestors = ancestorsOf(tree, reveal.path).slice(0, reveal.expand ? undefined : -1)
    if (ancestors.some((a) => !expanded.has(a.path))) setExpanded((prev) => new Set([...prev, ...ancestors.map((a) => a.path)]))
    setActive(reveal.path)
    setPendingScroll(reveal.path)
  }
  useEffect(() => {
    if (!pendingScroll) return
    const index = rows.findIndex((r) => r.node.path === pendingScroll)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
    setPendingScroll(null)
  }, [pendingScroll, rows, virtualizer])

  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    setActive(row.node.path)
    virtualizer.scrollToIndex(rows.indexOf(row), { align: 'auto' })
  }

  const activate = (row: Row) => {
    if (isPage(row.node)) void openPage(row.node.path)
    else setOpen(row.node.path, !row.open)
  }

  const menuItems = (row: Row): MenuItem[] =>
    isPage(row.node)
      ? [
          { label: '開く', keys: '↩', run: () => void openPage(row.node.path) },
          { label: '子ページを作成', keys: '⌘⇧N', run: () => void openPage(row.node.path).then(() => newPage('child')) },
          {
            label: '名前を変更',
            run: () => void openPage(row.node.path).then(() => focusTitle(row.node.path, true)),
          },
          { label: '削除', keys: '⌘⌫', run: () => void requestDelete(row.node.path) },
        ]
      : [
          { label: '新規ページ', run: () => void newPage({ folder: row.node.path }) },
          { label: '新規フォルダ', run: () => void newFolder(row.node.path) },
          { label: '名前を変更', keys: 'F2', run: () => setRenamingFolder(row.node.path) },
          { label: '削除', keys: '⌘⌫', run: () => void requestDelete(row.node.path) },
        ]

  // 落としたら、行をすぐ新しい場所へ滑らせる(ファイルの移動は裏で行う)。開いていたフォルダは、動かした先でも開いたまま
  const move = (path: string, parent: string | null) =>
    flipRows(scrollRef.current, () => {
      const to = movedPath(path, parent)
      setExpanded((prev) => new Set([...prev].map((p) => remapPath(p, path, to))))
      void moveEntry(path, parent)
    })
  const drag = useTreeDrag(scrollRef, rows, tree, (row) => setOpen(row, true), move)

  const openMenuAt = (row: Row, el: Element | null) => {
    const r = el?.getBoundingClientRect()
    setMenu({ row, at: { x: (r?.left ?? 0) + 24, y: (r?.bottom ?? 0) + 2 } })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (isComposing(e.nativeEvent) || rows.length === 0) return
    const row = rows[activeIndex]
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    switch (e.key) {
      case 'ArrowDown':
        handled()
        moveTo(activeIndex + 1)
        break
      case 'ArrowUp':
        handled()
        moveTo(activeIndex - 1)
        break
      case 'Home':
        handled()
        moveTo(0)
        break
      case 'End':
        handled()
        moveTo(rows.length - 1)
        break
      case 'ArrowRight':
        handled()
        if (row.node.children.length > 0 && !row.open) setOpen(row.node.path, true)
        else if (row.open) moveTo(activeIndex + 1)
        break
      case 'ArrowLeft':
        handled()
        if (row.open) setOpen(row.node.path, false)
        else if (row.parent) moveTo(rows.findIndex((r) => r.node.path === row.parent))
        break
      case 'Enter':
      case ' ':
        handled()
        activate(row)
        break
      case 'Backspace':
      case 'Delete':
        if (modPressed(e) || e.key === 'Delete') {
          handled()
          void requestDelete(row.node.path)
        }
        break
      case 'F2':
        handled()
        if (isPage(row.node)) void openPage(row.node.path).then(() => focusTitle(row.node.path, true))
        else setRenamingFolder(row.node.path)
        break
      case 'F10':
        if (e.shiftKey) {
          handled()
          openMenuAt(row, document.getElementById(rowId(activeIndex)))
        }
        break
      case 'ContextMenu':
        handled()
        openMenuAt(row, document.getElementById(rowId(activeIndex)))
        break
    }
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-drop={drag.target?.mode === 'root' ? 'root' : undefined}>
      <ul
        role="tree"
        aria-label="ノート"
        tabIndex={0}
        aria-activedescendant={rows.length > 0 ? rowId(activeIndex) : undefined}
        className="tree relative outline-none"
        style={{ height: virtualizer.getTotalSize() }}
        onKeyDown={onKeyDown}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          const { node, depth, open } = row
          const page = isPage(node)
          const selected = node.path === selectedPath
          const hasChildren = node.children.length > 0
          return (
            <li
              key={item.key}
              id={rowId(item.index)}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected}
              aria-expanded={hasChildren ? open : undefined}
              data-row={node.path}
              data-active={item.index === activeIndex || undefined}
              data-drop={drag.target?.mode === 'into' && drag.target.row === node.path ? 'into' : undefined}
              data-dragging={drag.dragging === node.path || undefined}
              className={cn(
                'tree-row hover-fade absolute inset-x-0 flex cursor-default items-center gap-1.5 rounded-sm pr-2 text-base',
                selected ? 'tree-row-selected bg-accent font-medium text-on-accent' : 'hover:bg-border/60',
              )}
              style={{ top: item.start, height: ROW_HEIGHT, paddingLeft: 4 + depth * 14 }}
              onMouseDown={(e) => {
                // クリックでもツリーに入力位置を置き、続けてキーボードで操作できるようにする
                e.preventDefault()
                setActive(node.path)
                e.currentTarget.closest<HTMLElement>('[role=tree]')?.focus()
                if (e.button === 0 && renamingFolder !== node.path) drag.press(row, e)
              }}
              onClick={() => {
                // つかんで動かした後のクリックは、開く操作にしない
                if (!drag.consumeClick()) activate(row)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setActive(node.path)
                setMenu({ row, at: { x: e.clientX, y: e.clientY } })
              }}
              onMouseEnter={() => page && prefetch(node.path)}
            >
              <span
                className={cn('flex w-3.5 justify-center text-muted', !hasChildren && 'invisible')}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(node.path, !open)
                }}
              >
                <ChevronRight size={12} className="chevron" data-open={open} />
              </span>
              {node.icon ? (
                <span className="tree-icon flex w-[15px] justify-center">{node.icon}</span>
              ) : (
                <span className="text-muted">{page ? <FileText size={15} /> : open ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
              )}
              {renamingFolder === node.path ? (
                <FolderNameInput
                  initial={node.title}
                  onDone={(name) => {
                    void renameFolder(node.path, name)
                    scrollRef.current?.querySelector<HTMLElement>('[role=tree]')?.focus()
                  }}
                  onCancel={() => {
                    setRenamingFolder(null)
                    scrollRef.current?.querySelector<HTMLElement>('[role=tree]')?.focus()
                  }}
                />
              ) : (
                <span className="truncate">{node.title}</span>
              )}
            </li>
          )
        })}
        {drag.line && <li aria-hidden className="tree-drop-line" style={{ top: drag.line.top, left: drag.line.left }} />}
      </ul>
      {drag.ghost && (
        <div className="tree-drag-ghost" style={{ left: drag.ghost.x + 12, top: drag.ghost.y + 8 }}>
          {drag.ghost.title}
        </div>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu ? menuItems(menu.row) : []} onClose={() => setMenu(null)} />
    </div>
  )
}

const rowId = (index: number) => `tree-row-${index}`

/** フォルダの名前をその場で変える入力欄。Enter か入力欄の外を押すと決まり、Esc でやめる */
function FolderNameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const finished = useRef(false)
  const finish = (fn: () => void) => {
    if (finished.current) return
    finished.current = true
    fn()
  }
  return (
    <input
      // 作ったばかりのフォルダは、そのまま打ち替えられるように全体を選んでおく
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus()
          el.select()
        }
      }}
      defaultValue={initial}
      aria-label="フォルダの名前"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm border border-accent bg-panel px-1 text-base text-text outline-none"
      // ツリーの行のクリックやキー操作に渡さない
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (isComposing(e.nativeEvent)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          const value = e.currentTarget.value
          finish(() => onDone(value))
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(onCancel)
        }
      }}
      onBlur={(e) => {
        const value = e.currentTarget.value
        finish(() => onDone(value))
      }}
    />
  )
}

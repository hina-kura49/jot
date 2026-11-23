import { create } from 'zustand'
import { backend, INBOX_PATH, isBackendError, toBackendError, type PageMeta, type TreeNode } from '@/backend'
import { errorText, logError, textFor } from '@/lib/error-text'
import CAPTURE_SHORTCUT from '@/capture/shortcut.json'
import { activeSession, flushActive } from '@/editor/registry'
import { createGuide, GUIDE_PATH } from './guide'
import { moveInTree, movedPath, remapPath } from './tree-move'

export const RECENT_LIMIT = 20
export const SEARCH_LIMIT = 50

type PageContent = { content: string; version: string }

/**
 * 本文に表示しているページ。
 * loadId はディスクから読んだ内容で文書を差し替えるたびに増える。保存結果の反映では増えない。
 * unreadable は開けないファイル(UTF-8 でないなど)。エディタを出さない。
 */
/** renamed: 名前が変わっただけで、エディタの文書はそのまま(読み直さない・入ってくる動きも出さない) */
export type OpenPage = { path: string; loadId: number; renamed?: boolean } & ({ content: string; version: string; unreadable?: undefined } | { unreadable: 'notUtf8' })

export type NoticeAction = { label: string; run: () => void | Promise<void> }
/** 画面上部の通知(デザイン 7)。warning は確認が必要なもの、info は知らせるだけのもの */
/** focus: 出たときに最初のボタンへ入力位置を移す(キーボードだけで答えられるようにする)。閉じたら元の場所へ戻す */
export type Notice = { id: number; tone: 'warning' | 'info'; title: string; body?: string; actions: NoticeAction[]; focus?: boolean }

type AppState = {
  /** loading: 起動中 / no-vault: 初回起動(保管庫未選択) / ready: 使える */
  status: 'loading' | 'no-vault' | 'ready'
  tree: TreeNode[]
  recent: PageMeta[]
  /** サイドバーで選ばれているページ。クリックした瞬間に変わる */
  selectedPath: string | null
  /** 本文に表示しているページ。読み込みが終わるまでは前のページのまま(画面を空にしない) */
  page: OpenPage | null
  /** 一度読んだページの控え。再訪問は待たずに表示する */
  cache: Record<string, PageContent>
  notice: Notice | null
  sidebarCollapsed: boolean
  /** ツリーでこのページの行を見せる(祖先を開いてスクロールする)。seq は同じページでも合図を出し直すため */
  reveal: { path: string; seq: number; expand?: boolean } | null
  /** ページのタイトルに入力位置を移す。select なら全体を選ぶ(作ったばかりのページ) */
  titleFocus: { path: string; seq: number; select: boolean } | null
  /** サイドバーでその場で名前を変えているフォルダ */
  renamingFolder: string | null

  init(): Promise<void>
  openVault(): Promise<void>
  /** 使い方のノートを開く。なければ保管庫の直下に作る */
  openGuide(): Promise<void>
  refreshTree(): Promise<void>
  openPage(path: string): Promise<void>
  prefetch(path: string): void
  /** Inbox(クイックキャプチャの取り込み先)を開く。まだなければ、作られ方を知らせる */
  openInbox(): Promise<void>
  closePage(): void
  /** ディスクの内容で、開いているページを差し替える(未保存の変更がないときだけ呼ぶ) */
  replaceOpenPage(path: string, fresh: PageContent): void
  /** 保存できた内容を控えに反映する。文書は差し替えない */
  markSaved(path: string, content: string, version: string): void
  handleExternalChange(): Promise<void>
  createPage(parentPath: string | null, title: string): Promise<PageMeta | null>
  renamePage(path: string, newTitle: string): Promise<PageMeta | null>
  /** ページかフォルダを、中身ごとゴミ箱へ移す */
  deletePage(path: string): Promise<void>
  /** 削除の入口。中にページがあるページ・フォルダだけ、件数を示して確認してから削除する */
  requestDelete(path: string): Promise<void>
  /** 新規ページを作って開き、タイトルを選んだ状態にする。sibling: 開いているページと同じフォルダ / child: 子ページ / folder: 指定のフォルダ */
  newPage(where: 'sibling' | 'child' | { folder: string | null }): Promise<void>
  focusTitle(path: string, select?: boolean): void
  /** 空のフォルダを作り、サイドバーでその場で名前を付けられるようにする。parent: フォルダかページ。null なら最上位 */
  newFolder(parent: string | null): Promise<void>
  /** サイドバーでのフォルダの名前変更を始める / やめる */
  setRenamingFolder(path: string | null): void
  /** 開いているページのアイコンを変える(null は消す)。ツリーにはすぐ出し、ファイルへは自動保存で書く */
  setPageIcon(path: string, icon: string | null): void
  /** 改名・移動の後に、開いているページ(元は oldPath、今は newPath)を読み直す */
  reloadMoved(oldPath: string, newPath: string): Promise<void>
  /** ページかフォルダを、parent(ページ・フォルダ・null ならルート)の中へ動かす。動かせたら新しい path */
  moveEntry(path: string, parent: string | null): Promise<string | null>
  /** フォルダの行をサイドバーで見せ、そのフォルダも開く(パンくずから)。サイドバーを閉じていれば開く */
  revealFolder(path: string): void
  renameFolder(path: string, newName: string): Promise<void>
  /** クイックキャプチャのホットキーを登録できなかったことを知らせる */
  warnCaptureShortcut(): void
  showNotice(notice: Omit<Notice, 'id'>): void
  dismissNotice(id?: number): void
  toggleSidebar(): void
}

let openSeq = 0
let loadSeq = 0
let noticeSeq = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let signalSeq = 0

const descendantPaths = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => [n.path, ...descendantPaths(n.children)])

const findNode = (nodes: TreeNode[], path: string): TreeNode | null => {
  for (const n of nodes) {
    if (n.path === path) return n
    const hit = findNode(n.children, path)
    if (hit) return hit
  }
  return null
}

export const useApp = create<AppState>()((set, get) => ({
  status: 'loading',
  tree: [],
  recent: [],
  selectedPath: null,
  page: null,
  cache: {},
  notice: null,
  sidebarCollapsed: false,
  reveal: null,
  titleFocus: null,
  renamingFolder: null,

  async init() {
    try {
      const vault = await backend().currentVault()
      if (vault === null) {
        set({ status: 'no-vault' })
        return
      }
      const [tree, recent] = await Promise.all([backend().listTree(), backend().recentPages(RECENT_LIMIT)])
      set({ status: 'ready', tree, recent })
    } catch (e) {
      // 保管庫を読めない(フォルダが移動・削除された、権限がないなど)。初回起動の画面で、選び直すか、もう一度試してもらう
      set({ status: 'no-vault', tree: [], recent: [] })
      get().showNotice({
        tone: 'warning',
        title: '保管庫を開けませんでした',
        body: errorText('loadVault', e),
        actions: [{ label: 'もう一度試す', run: () => get().init() }],
      })
      return
    }
    const first = get().recent[0]?.path ?? firstPage(get().tree)
    if (first) await get().openPage(first)
  },

  async openVault() {
    try {
      // 選び直す前に、いまの保管庫の未保存の変更を保存し終える
      await flushActive()
      const vault = await backend().openVault()
      if (vault === null) return
      // 前の保管庫のページを残さない
      get().closePage()
      set({ tree: [], recent: [], cache: {}, selectedPath: null })
      await get().init()
      // 空のフォルダを選んだときは、使い方のノートを1枚作って開く(すでにノートがあるフォルダには何も足さない)
      if (get().status === 'ready' && get().tree.length === 0) await get().openGuide()
    } catch (e) {
      // 選んだフォルダを開けなかったときは、いまの保管庫のまま(切り替えは開けた後にだけ行う)
      if (isBackendError(e, 'indexOverlapsVault')) {
        logError('openVault', toBackendError(e))
        get().showNotice({ tone: 'warning', title: 'このフォルダは保管庫にできません。別のフォルダを選んでください。', actions: [] })
        return
      }
      get().showNotice({ tone: 'warning', title: 'フォルダを開けませんでした', body: errorText('openVault', e), actions: [] })
    }
  },

  async openGuide() {
    try {
      let path: string | null = findNode(get().tree, GUIDE_PATH) ? GUIDE_PATH : null
      if (path === null) {
        path = await createGuide()
        await get().refreshTree()
      }
      await get().openPage(path)
    } catch (e) {
      get().showNotice({ tone: 'warning', title: '使い方のノートを作れませんでした', body: errorText('createPage', e), actions: [] })
    }
  },

  async refreshTree() {
    // 失敗しても投げない(呼ぶ側の操作そのものは済んでいる)。いまのツリーを残して知らせる
    try {
      const [tree, recent] = await Promise.all([backend().listTree(), backend().recentPages(RECENT_LIMIT)])
      set({ tree, recent })
    } catch (e) {
      get().showNotice({ tone: 'warning', title: 'ページの一覧を読み直せませんでした', body: errorText('refreshTree', e), actions: [] })
    }
  },

  async openPage(path) {
    if (get().page?.path === path && get().selectedPath === path) return
    // 前のページの未保存の変更を書き出し始める(書き出す内容はこの時点で決まる。待たずに切り替える)
    void flushActive()
    const seq = ++openSeq
    const cached = get().cache[path]
    const reveal = { path, seq: ++signalSeq }
    set(cached ? { selectedPath: path, reveal, page: { path, ...cached, loadId: ++loadSeq } } : { selectedPath: path, reveal })
    try {
      const fresh = await backend().readPage(path)
      set((s) => ({ cache: { ...s.cache, [path]: fresh } }))
      // 読み込み中に別のページへ移っていたら、表示は差し替えない
      if (seq !== openSeq) return
      if (!cached || cached.version !== fresh.version) set({ page: { path, ...fresh, loadId: ++loadSeq } })
    } catch (e) {
      if (seq !== openSeq) return
      const err = toBackendError(e)
      logError('openPage', err)
      if (err.kind === 'notUtf8') set({ page: { path, unreadable: 'notUtf8', loadId: ++loadSeq } })
      else if (err.kind === 'notFound') {
        set({ selectedPath: get().page?.path ?? null })
        get().showNotice({ tone: 'warning', title: 'このページは見つかりませんでした', body: '他のアプリで移動または削除された可能性があります。', actions: [] })
        void get().refreshTree()
      } else {
        get().showNotice({ tone: 'warning', title: 'ページを開けませんでした', body: textFor('openPage', err.kind), actions: [] })
      }
      return
    }
    void backend()
      .recentPages(RECENT_LIMIT)
      .then((recent) => set({ recent }))
      .catch(() => {})
  },

  async openInbox() {
    if (findNode(get().tree, INBOX_PATH)) return get().openPage(INBOX_PATH)
    get().showNotice({
      tone: 'info',
      title: 'Inbox はまだありません',
      body: `クイックキャプチャ(${CAPTURE_SHORTCUT.label})でメモを取り込むと作られます。`,
      actions: [],
    })
  },

  warnCaptureShortcut() {
    get().showNotice({
      tone: 'warning',
      title: `${CAPTURE_SHORTCUT.label} はほかのアプリが使っているため、クイックキャプチャのショートカットを登録できませんでした`,
      actions: [],
    })
  },

  prefetch(path) {
    if (get().cache[path]) return
    void backend()
      .readPage(path)
      .then((fresh) => set((s) => ({ cache: { [path]: fresh, ...s.cache } })))
      .catch(() => {})
  },

  closePage() {
    set({ page: null, selectedPath: null })
  },

  replaceOpenPage(path, fresh) {
    set((s) => ({
      cache: { ...s.cache, [path]: fresh },
      page: s.page?.path === path ? { path, ...fresh, loadId: ++loadSeq } : s.page,
    }))
  },

  markSaved(path, content, version) {
    set((s) => {
      const page = s.page?.path === path && !s.page.unreadable ? { ...s.page, content, version } : s.page
      return { cache: { ...s.cache, [path]: { content, version } }, page }
    })
  },

  async handleExternalChange() {
    await get().refreshTree()
    const page = get().page
    if (!page || page.unreadable) return
    // 保存中なら書き終えてから比べる(自分の保存による変更を外部の変更と取り違えない)
    await flushActive()
    const session = activeSession()
    const known = session?.current()
    if (!known || known.path !== page.path) return
    let fresh: PageContent
    try {
      fresh = await backend().readPage(page.path)
    } catch (e) {
      if (isBackendError(e, 'notFound')) {
        if (session?.isDirty()) {
          // 未保存の変更がある: 保存時と同じ「作り直す / 破棄する」を尋ねる(エディタ側が次の保存で出す)
          void session.flush()
        } else {
          get().closePage()
        }
      }
      return
    }
    if (fresh.version === known.version) return
    if (!session?.isDirty()) {
      get().replaceOpenPage(page.path, fresh)
      return
    }
    get().showNotice({
      tone: 'warning',
      title: 'このファイルは、他のアプリで変更されました。',
      body: '最新の内容を読み込みますか？',
      actions: [
        { label: '再読み込み', run: () => get().replaceOpenPage(page.path, fresh) },
        // 自分の変更で上書きする: 保存の基準を最新の version にしてから保存する
        { label: '自分の変更を保持', run: () => activeSession()?.overwriteWith(fresh.version) },
      ],
    })
  },

  async createPage(parentPath, title) {
    await flushActive()
    try {
      const meta = await backend().createPage(parentPath, title)
      await get().refreshTree()
      return meta
    } catch (e) {
      get().showNotice({ tone: 'warning', title: 'ページを作れませんでした', body: errorText('createPage', e), actions: [] })
      return null
    }
  },

  async renamePage(path, newTitle) {
    await flushActive()
    // 名前を変え終えるまで、開いているページの保存を待たせる(Enter ですぐ本文に打った文字を、なくなった元の名前に書かないように)。
    // 新しい path へは、読み直し(reloadMoved)で付け替える
    const open = get().page
    const release = open ? (activeSession()?.beginMove(open.path, open.path) ?? null) : null
    try {
      const meta = await backend().renamePage(path, newTitle)
      await get().refreshTree()
      // ほかのページへのリンクが書き換えられ version が変わるので、開いているページを読み直す
      if (open) await get().reloadMoved(open.path, open.path === path ? meta.path : open.path)
      return meta
    } catch (e) {
      const err = toBackendError(e)
      logError('renamePage', err)
      // タイトルはツリーから表示しているので、取り直せば元に戻る
      await get().refreshTree()
      get().showNotice({
        tone: 'warning',
        title: err.kind === 'nameOccupied' ? '同じ名前のページがあります' : '名前を変えられませんでした',
        body: err.kind === 'nameOccupied' ? '別の名前にしてください。' : textFor('renamePage', err.kind),
        actions: [],
      })
      return null
    } finally {
      release?.(true)
    }
  },

  async deletePage(path) {
    await flushActive()
    const node = findNode(get().tree, path)
    try {
      if (node && !isPage(node)) await backend().deleteFolder(path)
      else await backend().deletePage(path)
    } catch (e) {
      get().showNotice({ tone: 'warning', title: '削除できませんでした', body: errorText('deletePage', e), actions: [] })
      return
    }
    // 子ページも一緒に消える(ツリーの子孫)
    const gone = new Set([path, ...(node ? descendantPaths(node.children) : [])])
    const wasOpen = gone.has(get().page?.path ?? '')
    if (wasOpen) get().closePage()
    set((s) => ({ cache: Object.fromEntries(Object.entries(s.cache).filter(([p]) => !gone.has(p))) }))
    await get().refreshTree()
    get().showNotice({ tone: 'info', title: 'ゴミ箱に移動しました', body: '元に戻すときは、Finder のゴミ箱から戻してください。', actions: [] })
    // 開いていたページを消したら、本文を空にせず、最近開いたページ(なければツリーの最初のページ)を開く
    const next = wasOpen ? (get().recent.find((p) => !gone.has(p.path))?.path ?? firstPage(get().tree)) : null
    if (next && !get().page) await get().openPage(next)
  },

  async requestDelete(path) {
    const node = findNode(get().tree, path)
    const count = node ? countPages(node.children) : 0
    if (count === 0) return get().deletePage(path)
    get().showNotice({
      tone: 'warning',
      title: node && !isPage(node) ? `このフォルダと中のページ ${count} 件をゴミ箱に移動します` : `このページと子ページ ${count} 件をゴミ箱に移動します`,
      body: '元に戻すときは、Finder のゴミ箱から戻せます。',
      actions: [
        { label: 'ゴミ箱に移動', run: () => get().deletePage(path) },
        { label: 'キャンセル', run: () => {} },
      ],
      focus: true,
    })
  },

  async newPage(where) {
    const open = get().page?.path ?? null
    const parent =
      typeof where === 'object' ? where.folder : where === 'child' ? open : open ? findParentFolder(get().tree, open) : null
    const meta = await get().createPage(parent, '無題')
    if (!meta) return
    await get().openPage(meta.path)
    get().focusTitle(meta.path, true)
  },

  focusTitle(path, select = false) {
    set({ titleFocus: { path, seq: ++signalSeq, select } })
  },

  async newFolder(parent) {
    let path: string
    try {
      path = await backend().createFolder(parent, '新しいフォルダ')
    } catch (e) {
      get().showNotice({ tone: 'warning', title: 'フォルダを作れませんでした', body: errorText('createFolder', e), actions: [] })
      return
    }
    await get().refreshTree()
    set({ reveal: { path, seq: ++signalSeq }, renamingFolder: path })
  },

  setPageIcon(path, icon) {
    if (!activeSession()?.setIcon(path, icon)) return
    const withIcon = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => {
        if (n.path === path) return { ...n, icon: icon ?? undefined }
        return n.children.length > 0 ? { ...n, children: withIcon(n.children) } : n
      })
    set((s) => ({ tree: withIcon(s.tree) }))
  },

  async reloadMoved(oldPath, newPath) {
    try {
      // リンクの書き換えで、開いているページの version も変わることがある
      const fresh = await backend().readPage(newPath)
      // 中身が知っている内容と同じなら、エディタは読み直さない(入力位置と、待つ間に打った文字を保つ)
      const renamed = activeSession()?.rebind(oldPath, newPath, fresh.content, fresh.version) ?? false
      set((s) => ({
        selectedPath: s.selectedPath === oldPath ? newPath : s.selectedPath,
        cache: { ...s.cache, [newPath]: fresh },
        page: { path: newPath, ...fresh, loadId: renamed && s.page ? s.page.loadId : ++loadSeq, renamed },
      }))
    } catch (e) {
      logError('reloadMoved', toBackendError(e))
    }
  },

  async moveEntry(path, parent) {
    const node = findNode(get().tree, path)
    if (!node) return null
    // 未保存の変更は、動かす前の path に書き出す(書き出す内容と path はこの時点で決まる)
    const flushed = flushActive()
    // 見た目を先に動かす: ツリーと開いているページの path をすぐ新しい場所にし、ファイルの移動は裏で行う
    const before = get().tree
    const guess = movedPath(path, parent)
    const optimistic = moveInTree(before, path, parent)
    const open = get().page
    let finishMove: ((ok: boolean) => void) | null = null
    if (optimistic) {
      const remap = (p: string) => remapPath(p, path, guess)
      if (open && remap(open.path) !== open.path) finishMove = activeSession()?.beginMove(open.path, remap(open.path)) ?? null
      set((s) => ({
        tree: optimistic,
        selectedPath: s.selectedPath && remap(s.selectedPath),
        // エディタが動かし始めていれば、文書はそのままで path だけを変える
        page: finishMove && s.page ? { ...s.page, path: remap(s.page.path), renamed: true } : s.page,
        reveal: { path: guess, seq: ++signalSeq },
      }))
    }
    let next: string
    try {
      await flushed
      next = isPage(node) ? (await backend().movePage(path, parent)).path : await backend().moveFolder(path, parent)
    } catch (e) {
      const err = toBackendError(e)
      logError('moveEntry', err)
      // 先に動かした見た目を元に戻す
      if (optimistic) {
        finishMove?.(false)
        set((s) => ({
          tree: before,
          selectedPath: s.selectedPath && remapPath(s.selectedPath, guess, path),
          page: finishMove && s.page && open ? { ...s.page, path: open.path, renamed: true } : s.page,
          reveal: { path, seq: ++signalSeq },
        }))
      }
      get().showNotice({
        tone: 'warning',
        title: err.kind === 'nameOccupied' ? '移動先に同じ名前のものがあります' : '移動できませんでした',
        body: err.kind === 'nameOccupied' ? '名前を変えてから移動してください。' : textFor('moveEntry', err.kind),
        actions: [],
      })
      return null
    }
    if (next === path) {
      finishMove?.(true)
      return next
    }
    try {
      await get().refreshTree()
      // 中のページの path が変わる。控えを捨て、開いているページは新しい path で読み直す(リンクの書き換えで version が変わる)
      const moved = (p: string) => remapPath(p, path, next)
      set((s) => ({ cache: Object.fromEntries(Object.entries(s.cache).filter(([p]) => moved(p) === p)) }))
      // 待つ間にほかのページを開いていることもあるので、いま開いているページで考える
      const now = get().page
      if (now) {
        // 先に動かした path(guess の下)は元の path に戻してから、実際の移動先に読み替える(名前が変わったときも合う)
        const original = optimistic ? remapPath(now.path, guess, path) : now.path
        await get().reloadMoved(now.path, moved(original))
      }
      if (!optimistic || guess !== next) set({ reveal: { path: next, seq: ++signalSeq } })
    } finally {
      // 保存を再開する(待っていた変更は、新しい path に書き出す)
      finishMove?.(true)
    }
    return next
  },

  revealFolder(path) {
    set({ sidebarCollapsed: false, reveal: { path, seq: ++signalSeq, expand: true } })
  },

  setRenamingFolder(path) {
    set({ renamingFolder: path })
  },

  async renameFolder(path, newName) {
    set({ renamingFolder: null })
    if (newName.trim() === '' || newName === titleOf(get().tree, path)) return
    await flushActive()
    let next: string
    try {
      next = await backend().renameFolder(path, newName)
    } catch (e) {
      const err = toBackendError(e)
      logError('renameFolder', err)
      get().showNotice({
        tone: 'warning',
        title: err.kind === 'nameOccupied' ? '同じ名前のフォルダかページがあります' : '名前を変えられませんでした',
        body: err.kind === 'nameOccupied' ? '別の名前にしてください。' : textFor('renameFolder', err.kind),
        actions: [],
      })
      return
    }
    await get().refreshTree()
    // 中のページの path が変わる。控えを捨て、開いているページは新しい path で読み直す
    const moved = (p: string) => (p.startsWith(`${path}/`) ? next + p.slice(path.length) : p)
    set((s) => ({ cache: Object.fromEntries(Object.entries(s.cache).filter(([p]) => moved(p) === p)) }))
    const open = get().page
    if (open) await get().reloadMoved(open.path, moved(open.path))
    // 中のページを開いていれば、そのページの行を見せる(フォルダを開いたままにする)
    const shown = open && moved(open.path) !== open.path ? moved(open.path) : next
    set({ reveal: { path: shown, seq: ++signalSeq } })
  },

  showNotice(notice) {
    const id = ++noticeSeq
    clearTimeout(noticeTimer)
    set({ notice: { ...notice, id } })
    // 知らせるだけの通知は、しばらくしたら消す
    if (notice.tone === 'info') noticeTimer = setTimeout(() => get().dismissNotice(id), 5000)
  },

  dismissNotice(id) {
    if (id === undefined || get().notice?.id === id) set({ notice: null })
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  },
}))

/** ツリーから path までの祖先(自分を含む)をたどる。パンくずに使う。 */
export function ancestorsOf(tree: TreeNode[], path: string): TreeNode[] {
  for (const node of tree) {
    if (node.path === path) return [node]
    const below = ancestorsOf(node.children, path)
    if (below.length > 0) return [node, ...below]
  }
  return []
}

export const isPage = (node: TreeNode) => node.kind === 'page'

/** ツリーの中のページの数(子フォルダの中身も数える) */
/** ツリーの上から最初のページ。ページが1つもなければ null */
export function firstPage(nodes: TreeNode[]): string | null {
  for (const n of nodes) {
    if (isPage(n)) return n.path
    const inner = firstPage(n.children)
    if (inner) return inner
  }
  return null
}

export const countPages = (nodes: TreeNode[]): number => nodes.reduce((n, c) => n + (isPage(c) ? 1 : 0) + countPages(c.children), 0)

/** ページの入っているフォルダ(ツリーの親)。ルートなら null。path は加工せず、ツリーの親子関係から求める */
export function findParentFolder(tree: TreeNode[], path: string): string | null {
  const trail = ancestorsOf(tree, path)
  return trail.length >= 2 ? trail[trail.length - 2].path : null
}

/** ページのタイトル(バックエンドが返したもの)。ツリーにまだなければ null */
export const titleOf = (tree: TreeNode[], path: string): string | null => findNode(tree, path)?.title ?? null

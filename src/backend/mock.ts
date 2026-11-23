import { dirOf, hasScheme, resolveInVault } from '@/lib/paths'
import { readIcon } from '@/lib/frontmatter'
import { MOCK_FOLDERS, MOCK_PAGES, MOCK_RECENT, MOCK_SPECIAL, MOCK_VAULT } from './mock-data'
import {
  BackendError,
  INBOX_PATH as INBOX,
  isExternalUrl,
  type Backend,
  type PageMeta,
  type PickedFile,
  type SearchHit,
  type TreeNode,
  type WriteResult,
} from './types'

export type MockOptions = {
  /** 前回開いた保管庫。null なら初回起動(フォルダ未選択)の状態 */
  vault?: string | null
  /** 空の保管庫で始める */
  empty?: boolean
  /** すべての呼び出しに足す遅延(ミリ秒)。ページ切り替えの確認用 */
  latencyMs?: number
}

type MockPage = { content: string; version: string; modifiedAt: number; readOnly?: boolean; notUtf8?: boolean }

const titleOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '')
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

const safeDecode = (s: string) => {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/** バックエンドと同じように、タイトルを整える(空白の除去、使えない文字の置き換え) */
const normalizeTitle = (title: string) => title.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim() || '無題'

/** 何もしなかった同期の結果 */


/** メモリ上のダミーデータで動くバックエンド。ブラウザ単体(vite dev)で全画面を確認するためのもの。 */
export class MockBackend implements Backend {
  private vault: string | null
  private folders: string[]
  private pages = new Map<string, MockPage>()
  private recent: string[]
  private listeners = new Set<() => void>()
  private clock = Date.now()
  private versionSeq = 0
  private latencyMs: number

  constructor(options: MockOptions = {}) {
    this.vault = options.vault === undefined ? MOCK_VAULT : options.vault
    this.latencyMs = options.latencyMs ?? 0
    const empty = options.empty ?? false
    this.folders = empty ? [] : [...MOCK_FOLDERS]
    if (!empty) {
      for (const [path, content] of MOCK_PAGES) this.put(path, content)
      for (const [path, content, flags] of MOCK_SPECIAL) this.put(path, content, flags)
    }
    this.recent = empty ? [] : [...MOCK_RECENT]
  }

  private put(path: string, content: string, flags: Partial<Pick<MockPage, 'readOnly' | 'notUtf8'>> = {}): MockPage {
    this.clock = Math.max(this.clock + 1, Date.now())
    const page = { content, version: `v${++this.versionSeq}`, modifiedAt: this.clock, ...flags }
    this.pages.set(path, page)
    return page
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs))
  }

  private page(path: string): MockPage {
    const page = this.pages.get(path)
    if (!page) throw new BackendError('notFound', `ページが見つかりません: ${path}`)
    return page
  }

  private meta(path: string): PageMeta {
    return { path, title: titleOf(path), modifiedAt: this.page(path).modifiedAt }
  }

  private touch(path: string): void {
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 100)
  }

  private uniquePath(dir: string, title: string): string {
    let path = join(dir, `${title}.md`)
    for (let n = 2; this.pages.has(path); n++) path = join(dir, `${title} ${n}.md`)
    return path
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb())
  }

  async currentVault(): Promise<string | null> {
    await this.delay()
    return this.vault
  }

  async openVault(): Promise<string | null> {
    await this.delay()
    this.vault = MOCK_VAULT
    return this.vault
  }

  async listTree(): Promise<TreeNode[]> {
    await this.delay()
    // 本物のバックエンドと同じく、ページと同じ名前のフォルダの中身は、そのページの子として並べる
    const nodes = new Map<string, TreeNode>()
    const root: TreeNode[] = []
    const container = (dir: string) => (dir ? (nodes.get(`${dir}.md`) ?? nodes.get(dir))?.children : root)
    const add = (path: string, kind: TreeNode['kind']) => {
      const icon = kind === 'page' ? readIcon(this.pages.get(path)?.content ?? '') : null
      const node: TreeNode = { path, title: titleOf(path), kind, children: [], ...(icon ? { icon } : {}) }
      nodes.set(path, node)
      ;(container(dirOf(path)) ?? root).push(node)
    }
    const pageDirs = new Set([...this.pages.keys()].map((p) => p.replace(/\.md$/, '')))
    // フォルダとページを浅い順に足す(親が先にあるように)。同じ名前のページがあるフォルダは、ページに合わせる
    const depth = (p: string) => p.split('/').length
    const entries: [string, TreeNode['kind']][] = [
      ...this.folders.filter((f) => !pageDirs.has(f)).map((f): [string, TreeNode['kind']] => [f, 'folder']),
      ...[...this.pages.keys()].map((p): [string, TreeNode['kind']] => [p, 'page']),
    ]
    for (const [path, kind] of entries.sort((a, b) => depth(a[0]) - depth(b[0]))) add(path, kind)
    return root
  }

  async readPage(path: string): Promise<{ content: string; version: string }> {
    await this.delay()
    const page = this.page(path)
    if (page.notUtf8) throw new BackendError('notUtf8', `UTF-8 ではありません: ${path}`)
    this.touch(path)
    return { content: page.content, version: page.version }
  }

  async writePage(path: string, content: string, baseVersion: string): Promise<WriteResult> {
    await this.delay()
    const page = this.page(path)
    if (page.readOnly) throw new BackendError('readOnly', `読み取り専用です: ${path}`)
    if (page.version !== baseVersion) return { status: 'conflict' }
    const next = this.put(path, content)
    this.touch(path)
    return { status: 'ok', version: next.version }
  }

  async createPage(parentPath: string | null, title: string): Promise<PageMeta> {
    await this.delay()
    // 親がページ(…/名前.md)なら、同じ名前のフォルダを作って子ページを入れる
    const dir = this.childDir(parentPath)
    const path = this.uniquePath(dir, normalizeTitle(title))
    this.put(path, '')
    this.touch(path)
    return this.meta(path)
  }

  async renamePage(path: string, newTitle: string): Promise<PageMeta> {
    await this.delay()
    this.page(path)
    const next = join(dirOf(path), `${normalizeTitle(newTitle)}.md`)
    if (next === path) return this.meta(path)
    if (this.pages.has(next)) throw new BackendError('nameOccupied', `同じ名前のページがあります: ${next}`)
    // Map の並び順(=サイドバーの並び)を保ったまま差し替える。子ページ用のフォルダも一緒に名前を変える
    const oldDir = path.replace(/\.md$/, '')
    const newDir = next.replace(/\.md$/, '')
    const moved = (p: string) => (p === path ? next : p === oldDir || p.startsWith(`${oldDir}/`) ? newDir + p.slice(oldDir.length) : p)
    this.pages = new Map([...this.pages].map(([p, v]) => [moved(p), v]))
    this.folders = this.folders.map(moved)
    this.recent = this.recent.map(moved)
    // 本物のバックエンドはほかのページからのリンクを書き換える。Mock では version を進めて同じ状況を再現する
    const renamed = this.page(next)
    this.put(next, renamed.content, { readOnly: renamed.readOnly })
    return this.meta(next)
  }

  async deletePage(path: string): Promise<void> {
    await this.delay()
    this.page(path)
    // 子ページ(同じ名前のフォルダの中身)も一緒にゴミ箱へ移す
    const dir = path.replace(/\.md$/, '')
    const gone = (p: string) => p === path || p === dir || p.startsWith(`${dir}/`)
    for (const p of [...this.pages.keys()]) if (gone(p)) this.pages.delete(p)
    this.folders = this.folders.filter((f) => !gone(f))
    this.recent = this.recent.filter((p) => !gone(p))
  }

  /** 子を置くフォルダ。親がページなら同じ名前のフォルダ(無ければ作る) */
  private childDir(parentPath: string | null): string {
    const dir = parentPath ?? ''
    if (this.pages.has(dir)) {
      const pageDir = dir.replace(/\.md$/, '')
      if (!this.folders.includes(pageDir)) this.folders.push(pageDir)
      return pageDir
    }
    if (dir && !this.folders.includes(dir)) throw new BackendError('notFound', `フォルダが見つかりません: ${dir}`)
    return dir
  }

  private taken(path: string): boolean {
    const lower = path.toLowerCase()
    return [...this.folders, ...this.pages.keys()].some((p) => p.toLowerCase() === lower || p.toLowerCase() === `${lower}.md`)
  }

  private isFolderNode(path: string): boolean {
    return this.folders.includes(path) && !this.pages.has(`${path}.md`)
  }

  async createFolder(parentPath: string | null, name: string): Promise<string> {
    await this.delay()
    const dir = this.childDir(parentPath)
    const base = join(dir, normalizeTitle(name))
    let path = base
    for (let n = 2; this.taken(path); n++) path = `${base} ${n}`
    this.folders.push(path)
    return path
  }

  async renameFolder(path: string, newName: string): Promise<string> {
    await this.delay()
    if (!this.isFolderNode(path)) throw new BackendError('notAPage', `フォルダではありません: ${path}`)
    const next = join(dirOf(path), normalizeTitle(newName))
    if (next === path) return path
    if (next.toLowerCase() !== path.toLowerCase() && this.taken(next)) throw new BackendError('nameOccupied', `同じ名前があります: ${next}`)
    const moved = (p: string) => (p === path || p.startsWith(`${path}/`) ? next + p.slice(path.length) : p)
    this.pages = new Map([...this.pages].map(([p, v]) => [moved(p), v]))
    this.folders = this.folders.map(moved)
    this.recent = this.recent.map(moved)
    return next
  }

  /** 貼り付けた画像(保管庫の中の path → 表示用の URL)。Mock にはファイルがないので、メモリに持つ */
  private attachments = new Map<string, string>()

  async saveAttachment(pagePath: string, name: string, bytes: Uint8Array): Promise<string> {
    await this.delay()
    this.page(pagePath)
    const folder = titleOf(pagePath)
    const dot = name.lastIndexOf('.')
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, '']
    let file = `${normalizeTitle(base)}${ext}`
    for (let n = 2; this.attachments.has(join(join(dirOf(pagePath), folder), file)); n++) file = `${normalizeTitle(base)} ${n}${ext}`
    this.attachments.set(join(join(dirOf(pagePath), folder), file), URL.createObjectURL(new Blob([new Uint8Array(bytes)])))
    return `${folder}/${file}`
  }

  /** 保管庫の中のフォルダに保存する(本物と同じく、名前を整え、同じ名前があれば「 2」から番号を付ける)。Mock ではメモリに持つ */
  async saveFile(folder: string, name: string, bytes: Uint8Array): Promise<string> {
    await this.delay()
    const segments = folder.split('/')
    if (folder === '' || folder.startsWith('/') || folder.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new BackendError('invalidPath', `正しくない path です: ${folder}`)
    }
    if (segments.some((s) => s.startsWith('.'))) throw new BackendError('notAPage', `隠しフォルダには保存しません: ${folder}`)
    const dot = name.lastIndexOf('.')
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, '']
    if (ext === '.md') throw new BackendError('notAPage', `ページは作れません: ${name}`)
    let file = `${normalizeTitle(base)}${ext}`
    for (let n = 2; this.attachments.has(join(folder, file)); n++) file = `${normalizeTitle(base)} ${n}${ext}`
    const path = join(folder, file)
    this.attachments.set(path, URL.createObjectURL(new Blob([new Uint8Array(bytes)])))
    return path
  }

  async savePage(folder: string, title: string, content: string): Promise<string> {
    await this.delay()
    const segments = folder.split('/')
    if (folder === '' || folder.startsWith('/') || folder.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new BackendError('invalidPath', `正しくない path です: ${folder}`)
    }
    if (segments.some((s) => s.startsWith('.'))) throw new BackendError('notAPage', `隠しフォルダには保存しません: ${folder}`)
    // 途中のフォルダを作る(ページの子フォルダとして既にあるものは、そのまま使う)
    segments.forEach((_, i) => {
      const dir = segments.slice(0, i + 1).join('/')
      if (!this.folders.includes(dir) && !this.pages.has(`${dir}.md`)) this.folders.push(dir)
    })
    const base = join(folder, normalizeTitle(title))
    let path = `${base}.md`
    for (let n = 2; this.pages.has(path); n++) path = `${base} ${n}.md`
    this.put(path, content)
    this.touch(path)
    return path
  }

  /** ブラウザでは、貼り付け・落としたファイルは画面に届くので、本体から読むものはない */
  async readClipboardFiles(): Promise<PickedFile[]> {
    return []
  }

  async readDroppedFiles(): Promise<PickedFile[]> {
    return []
  }

  /** ブラウザでは、落とされたファイルは画面に届く(file-paste.ts の handleDrop)ので使わない */
  async saveDroppedFiles(): Promise<string[]> {
    return []
  }

  /** ブラウザでは OS のクリップボードを直接読めない */
  async pasteClipboardFiles(): Promise<string[]> {
    return []
  }

  /** 貼り付けたファイルを、ブラウザの別のタブで開く */
  async openAttachment(pagePath: string, src: string): Promise<void> {
    const path = hasScheme(src) ? null : resolveInVault(dirOf(pagePath), safeDecode(src))
    const url = path === null ? undefined : this.attachments.get(path)
    if (!url) throw new BackendError('notFound', 'ファイルが見つかりません')
    window.open(url, '_blank', 'noopener')
  }

  async movePage(path: string, parentPath: string | null): Promise<PageMeta> {
    await this.delay()
    this.page(path)
    return this.meta(this.move(path, path.replace(/\.md$/, ''), parentPath))
  }

  async moveFolder(path: string, parentPath: string | null): Promise<string> {
    await this.delay()
    if (!this.isFolderNode(path)) throw new BackendError('notAPage', `フォルダではありません: ${path}`)
    return this.move(path, path, parentPath)
  }

  /** path(ページかフォルダ)と、その中(inner)を parentPath の中へ動かす */
  private move(path: string, inner: string, parentPath: string | null): string {
    const name = path.split('/').pop() ?? path
    // 子を置くフォルダ(childDir はページの子フォルダを作ってしまうので、確かめる前は名前だけ求める)
    const target = parentPath && this.pages.has(parentPath) ? parentPath.replace(/\.md$/, '') : (parentPath ?? '')
    if (target === dirOf(path)) return path
    if (target === inner || target.startsWith(`${inner}/`)) throw new BackendError('invalidPath', `自分の中へは動かせません: ${path}`)
    const dir = this.childDir(parentPath)
    const next = join(dir, name)
    const nextInner = join(dir, inner.split('/').pop() ?? inner)
    if (this.taken(next.replace(/\.md$/, ''))) throw new BackendError('nameOccupied', `同じ名前があります: ${next}`)
    const moved = (p: string) => (p === path ? next : p === inner || p.startsWith(`${inner}/`) ? nextInner + p.slice(inner.length) : p)
    this.pages = new Map([...this.pages].map(([p, v]) => [moved(p), v]))
    this.folders = this.folders.map(moved)
    this.recent = this.recent.map(moved)
    return next
  }

  async deleteFolder(path: string): Promise<void> {
    await this.delay()
    if (!this.isFolderNode(path)) throw new BackendError('notAPage', `フォルダではありません: ${path}`)
    const gone = (p: string) => p === path || p.startsWith(`${path}/`)
    for (const p of [...this.pages.keys()]) if (gone(p)) this.pages.delete(p)
    this.folders = this.folders.filter((f) => !gone(f))
    this.recent = this.recent.filter((p) => !gone(p))
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    await this.delay()
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    for (const [path, page] of this.pages) {
      if (hits.length >= limit) break
      if (page.notUtf8) continue
      const title = titleOf(path)
      const text = page.content.replace(/\s+/g, ' ')
      const at = text.toLowerCase().indexOf(q)
      const titleMatched = title.toLowerCase().includes(q)
      if (at === -1 && !titleMatched) continue
      const snippet =
        at === -1
          ? { before: text.slice(0, 40), hit: '', after: '' }
          : { before: text.slice(Math.max(0, at - 20), at), hit: text.slice(at, at + q.length), after: text.slice(at + q.length, at + q.length + 30) }
      hits.push({ path, title, titleMatched, snippet })
    }
    return hits
  }

  async recentPages(limit: number): Promise<PageMeta[]> {
    await this.delay()
    return this.recent
      .filter((p) => this.pages.has(p))
      .slice(0, limit)
      .map((p) => this.meta(p))
  }

  async captureToInbox(text: string): Promise<void> {
    await this.delay()
    if (text.trim() === '') return
    // 本物のバックエンドと同じく、前の内容との間を空行1つで区切って末尾に足す(前の内容はそのまま)
    const existing = this.pages.get(INBOX)?.content ?? ''
    const sep = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    this.put(INBOX, `${existing}${sep}${text}\n`)
    this.touch(INBOX)
    this.notify()
  }

  assetUrl(pagePath: string, src: string): string | null {
    if (hasScheme(src)) return src
    const path = resolveInVault(dirOf(pagePath), safeDecode(src))
    if (path === null) return null
    const saved = this.attachments.get(path)
    if (saved) return saved
    // Mock には画像ファイルがないので、パスごとに決まった仮の画像を返す
    return `https://picsum.photos/seed/${encodeURIComponent(path)}/1200/800`
  }

  onExternalChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** ページの外のリンク(Mock はブラウザを開かず、覚えておくだけ) */
  openedExternal: string[] = []

  async openExternalUrl(url: string): Promise<void> {
    if (!isExternalUrl(url)) throw new BackendError('invalidPath', 'http・https・mailto のリンクではありません(Mock)')
    this.openedExternal.push(url)
  }

  // ---- 開発用: 外部のアプリによる変更を再現する(開発者ツールから __mock.xxx で呼べる) ----

  /** 外部のアプリがファイルを書き換えた */
  simulateExternalEdit(path: string, content: string): void {
    this.put(path, content, { readOnly: this.pages.get(path)?.readOnly })
    this.notify()
  }

  /** 外部のアプリがファイルを消した */
  simulateExternalDelete(path: string): void {
    this.pages.delete(path)
    this.notify()
  }

  /** 読み取り専用にする / 戻す */
  setReadOnly(path: string, readOnly: boolean): void {
    const page = this.pages.get(path)
    if (page) page.readOnly = readOnly
  }
}

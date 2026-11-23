import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { dirOf, hasScheme, resolveInVault } from '@/lib/paths'
import type { PageContent } from './generated/PageContent'
import type { PageMeta as RawPageMeta } from './generated/PageMeta'
import {
  BackendError,
  toBackendError,
  type Backend,
  type PickedFile,
  type PageMeta,
  type SearchHit,
  type TreeNode,
  type WriteResult,
} from './types'

// Tauri の invoke とイベントを呼ぶだけの薄い層。Rust 側は src-tauri/src/vault.rs(core の Vault を呼ぶだけ)。
//
// Rust 側との取り決め:
// - コマンド名は snake_case。引数は Tauri 2 の既定どおり、JS の camelCase が Rust の snake_case に対応する
//   例: write_page(path: String, content: String, base_version: String)
// - 戻り値の型は Rust から作ったもの(./generated/)。契約と形が違う PageMeta(modifiedAt が bigint)だけ、ここで数値にそろえる
// - 失敗は { kind, message } の形(./generated/IpcError)。知らない kind でもフロントは落ちない
// - 外部変更は "external-change" イベント(payload なし)。保管庫の監視と、captureToInbox の後に Rust 側が出す
// - assetUrl は同期の関数なので invoke しない。保管庫の絶対パスと convertFileSrc で組み立てる
//   (Rust 側で、開いた保管庫だけを asset プロトコルで読めるようにしている)
export const EXTERNAL_CHANGE_EVENT = 'external-change'

/** そのまま表示に使ってよい URL(Web の画像と、埋め込みの画像)。file: などほかのスキームは保管庫の外を指しうるので使わない */
const PASS_THROUGH_SCHEME = /^(https?|data):/i

// Rust の u64 は JSON では数値で届く(型の上では bigint)。どちらでも数値にそろえる
const toPageMeta = (m: RawPageMeta): PageMeta => ({ path: m.path, title: m.title, modifiedAt: Number(m.modifiedAt) })


/**
 * read_clipboard_files・read_dropped_files の返すバイト列を読む(src-tauri/src/vault.rs の pack_files の形)。
 * ファイルごとに「名前のバイト数(u32 LE)・名前(UTF-8)・中身のバイト数(u32 LE)・中身」。途中で切れていたら、そこまでを返す
 */
export function unpackFiles(raw: ArrayBuffer | Uint8Array | number[]): PickedFile[] {
  const buf = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const text = new TextDecoder()
  const out: PickedFile[] = []
  let at = 0
  while (at + 4 <= buf.length) {
    const nameLen = view.getUint32(at, true)
    if (at + 4 + nameLen + 4 > buf.length) break
    const name = text.decode(buf.subarray(at + 4, at + 4 + nameLen))
    at += 4 + nameLen
    const size = view.getUint32(at, true)
    if (at + 4 + size > buf.length) break
    out.push({ name, bytes: buf.slice(at + 4, at + 4 + size) })
    at += 4 + size
  }
  return out
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toBackendError(e)
  }
}

export class TauriBackend implements Backend {
  /** 保管庫の絶対パス。assetUrl の組み立てに使う */
  private vault: string | null = null

  async currentVault(): Promise<string | null> {
    this.vault = await call<string | null>('current_vault')
    return this.vault
  }
  async openVault(): Promise<string | null> {
    const vault = await call<string | null>('open_vault')
    if (vault !== null) this.vault = vault
    return vault
  }
  listTree(): Promise<TreeNode[]> {
    return call<TreeNode[]>('list_tree')
  }
  readPage(path: string): Promise<PageContent> {
    return call<PageContent>('read_page', { path })
  }
  writePage(path: string, content: string, baseVersion: string): Promise<WriteResult> {
    return call<WriteResult>('write_page', { path, content, baseVersion })
  }
  async createPage(parentPath: string | null, title: string): Promise<PageMeta> {
    return toPageMeta(await call<RawPageMeta>('create_page', { parentPath, title }))
  }
  async renamePage(path: string, newTitle: string): Promise<PageMeta> {
    return toPageMeta(await call<RawPageMeta>('rename_page', { path, newTitle }))
  }
  deletePage(path: string): Promise<void> {
    return call<void>('delete_page', { path })
  }
  createFolder(parentPath: string | null, name: string): Promise<string> {
    return call<string>('create_folder', { parentPath, name })
  }
  renameFolder(path: string, newName: string): Promise<string> {
    return call<string>('rename_folder', { path, newName })
  }
  async saveAttachment(pagePath: string, name: string, bytes: Uint8Array): Promise<string> {
    // 中身は生のバイト列で送る(JSON にすると大きな画像で遅い)。path と名前はヘッダーで渡す
    try {
      return await invoke<string>('save_attachment', bytes, { headers: { 'x-page': encodeURIComponent(pagePath), 'x-name': encodeURIComponent(name) } })
    } catch (e) {
      throw toBackendError(e)
    }
  }
  async saveFile(folder: string, name: string, bytes: Uint8Array): Promise<string> {
    try {
      return await invoke<string>('save_file', bytes, { headers: { 'x-folder': encodeURIComponent(folder), 'x-name': encodeURIComponent(name) } })
    } catch (e) {
      throw toBackendError(e)
    }
  }
  savePage(folder: string, title: string, content: string): Promise<string> {
    return call<string>('save_page', { folder, title, content })
  }
  async readClipboardFiles(stem: string): Promise<PickedFile[]> {
    return unpackFiles(await call<ArrayBuffer>('read_clipboard_files', { stem }))
  }
  async readDroppedFiles(paths: string[]): Promise<PickedFile[]> {
    return unpackFiles(await call<ArrayBuffer>('read_dropped_files', { paths }))
  }
  saveDroppedFiles(pagePath: string, paths: string[]): Promise<string[]> {
    return call<string[]>('save_dropped_files', { pagePath, paths })
  }
  pasteClipboardFiles(pagePath: string, stem: string): Promise<string[]> {
    return call<string[]>('paste_clipboard_files', { pagePath, stem })
  }
  openAttachment(pagePath: string, src: string): Promise<void> {
    let decoded = src
    try {
      decoded = decodeURI(src)
    } catch {
      // そのまま使う
    }
    const path = hasScheme(src) ? null : resolveInVault(dirOf(pagePath), decoded)
    if (path === null) return Promise.reject(new BackendError('notFound', '保管庫の中のファイルではありません'))
    return call<void>('open_attachment', { path })
  }
  async movePage(path: string, parentPath: string | null): Promise<PageMeta> {
    return toPageMeta(await call<RawPageMeta>('move_page', { path, parentPath }))
  }
  moveFolder(path: string, parentPath: string | null): Promise<string> {
    return call<string>('move_folder', { path, parentPath })
  }
  deleteFolder(path: string): Promise<void> {
    return call<void>('delete_folder', { path })
  }
  search(query: string, limit: number): Promise<SearchHit[]> {
    return call<SearchHit[]>('search', { query, limit })
  }
  async recentPages(limit: number): Promise<PageMeta[]> {
    return (await call<RawPageMeta[]>('recent_pages', { limit })).map(toPageMeta)
  }
  captureToInbox(text: string): Promise<void> {
    // メインのウィンドウへの変更の知らせ(external-change)は、Rust 側が書き込みの後に出す
    return call<void>('capture_to_inbox', { text })
  }
  assetUrl(pagePath: string, src: string): string | null {
    if (hasScheme(src)) return PASS_THROUGH_SCHEME.test(src) ? src : null
    if (this.vault === null) return null
    let decoded = src
    try {
      decoded = decodeURI(src)
    } catch {
      // そのまま使う
    }
    const path = resolveInVault(dirOf(pagePath), decoded)
    return path === null ? null : convertFileSrc(`${this.vault.replace(/\/$/, '')}/${path}`)
  }
  openExternalUrl(url: string): Promise<void> {
    return call<void>('open_external_url', { url })
  }
  onExternalChange(cb: () => void): () => void {
    return subscribe(EXTERNAL_CHANGE_EVENT, () => cb())
  }
}

/** イベントを受ける。listen は Promise で解除関数を返すので、登録前に解除されても漏れないようにする */
function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  void listen<T>(event, (e) => cb(e.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

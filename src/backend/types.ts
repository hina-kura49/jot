// バックエンドとの契約。フロントはこのインターフェースだけを通してバックエンドと話す。
// 変更したいときは勝手に変えず、理由を添えて提案する。
//
// 約束ごと
// - version は中身の分からない文字列。受け取った値をそのまま次の writePage に渡す。
// - path は「/」区切りで、「:」を含むことがある。識別子としてそのまま使い、加工しない。
// - title はバックエンドが返したものを使う。createPage と renamePage は渡したタイトルを整えて返すことがある。
//   返ってきた title と path を正とする。
// - kind が "folder" の節点はページのないフォルダ。開閉だけで、readPage を呼ばない。createPage と createFolder の parentPath には渡せる。
//   空のフォルダも出る。画像などページ以外のファイルだけを入れたフォルダは出ない。
//   createFolder / renameFolder は、渡した名前を整えたうえでの path を返す。それを正とする。
// - movePage / moveFolder の parentPath は createPage と同じ(null ならルート)。同じ場所なら何もせず元の path を返す。
//   自分自身やその中へは動かせない(invalidPath)。移動先に同じ名前のものがあれば nameOccupied(番号は付けない)。
// - 知らないエラーの種類が来ても落ちない。
// - onExternalChange が呼ばれたら、listTree を取り直し、開いているページは readPage で version を比べる。

/** openExternalUrl で開けるリンク(http・https・mailto)。Rust の open_external_url と同じ決まり */
export const isExternalUrl = (url: string): boolean =>
  /^(https?:\/\/\S+|mailto:\S+)$/i.test(url) && ![...url].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

/** captureToInbox の書き込み先。バックエンドが保管庫の直下に作る */
export const INBOX_PATH = 'Inbox.md'

// 契約の型のうち、Rust の型から作ったもの(src/backend/generated/。npm run gen:types で作り直す)と形が一致するものは、それをそのまま使う。
// titleMatched: タイトルに検索語が当たったか。パレットの「ページ」と「本文の検索結果」の振り分けはこの値だけで行う
import type { ErrorKind } from './generated/ErrorKind'
import type { SearchHit } from './generated/SearchHit'
import type { TreeNode } from './generated/TreeNode'
import type { WriteResult } from './generated/WriteResult'
export type { NodeKind } from './generated/NodeKind'
export type { Snippet } from './generated/Snippet'
export type { SearchHit, TreeNode, WriteResult }
/** エラーの種類。indexOverlapsVault: 索引用のフォルダと保管庫が重なっている(openVault で返る) */
export type BackendErrorKind = ErrorKind

// PageMeta.modifiedAt は、生成された型では bigint(Rust の u64)。契約は number のままにし、TauriBackend で数値にそろえる
export type PageMeta = { path: string; title: string; modifiedAt: number } // UNIX時刻のミリ秒

const KNOWN_KINDS: readonly string[] = [
  'notFound',
  'invalidPath',
  'notAPage',
  'notUtf8',
  'readOnly',
  'nameOccupied',
  'indexOverlapsVault',
  'io',
] satisfies readonly BackendErrorKind[]

export class BackendError extends Error {
  readonly kind: BackendErrorKind
  /** 届いた種類のそのままの値。知らない種類のときは kind を 'io' として扱い、元の値はここに残す */
  readonly rawKind: string

  constructor(kind: string, message?: string) {
    super(message ?? kind)
    this.name = 'BackendError'
    this.rawKind = kind
    this.kind = KNOWN_KINDS.includes(kind) ? (kind as BackendErrorKind) : 'io'
  }
}

/** 呼び出しの失敗を BackendError にそろえる。知らない形のエラーでも落ちない */
export function toBackendError(e: unknown): BackendError {
  if (e instanceof BackendError) return e
  if (typeof e === 'object' && e !== null && 'kind' in e && typeof e.kind === 'string') {
    const message = 'message' in e && typeof e.message === 'string' ? e.message : undefined
    return new BackendError(e.kind, message)
  }
  return new BackendError('io', e instanceof Error ? e.message : String(e))
}

export const isBackendError = (e: unknown, kind: BackendErrorKind): boolean => toBackendError(e).kind === kind

/** 読んだだけで、まだ保存していないファイル(送る前のプレビュー) */
export type PickedFile = { name: string; bytes: Uint8Array }

export interface Backend {
  currentVault(): Promise<string | null> // 前回開いた保管庫。なければ null
  openVault(): Promise<string | null> // フォルダ選択。キャンセルなら null
  listTree(): Promise<TreeNode[]> // 並び順はバックエンドが決める。並べ替えない
  readPage(path: string): Promise<{ content: string; version: string }>
  writePage(path: string, content: string, baseVersion: string): Promise<WriteResult>
  createPage(parentPath: string | null, title: string): Promise<PageMeta>
  renamePage(path: string, newTitle: string): Promise<PageMeta>
  deletePage(path: string): Promise<void>
  createFolder(parentPath: string | null, name: string): Promise<string> // 空のフォルダを作り、その path を返す
  renameFolder(path: string, newName: string): Promise<string> // 新しい path を返す。中を指すリンクも書き換わる
  deleteFolder(path: string): Promise<void> // 中身ごとゴミ箱へ移す
  saveAttachment(pagePath: string, name: string, bytes: Uint8Array): Promise<string> // 貼り付けた画像などをページの子フォルダに保存し、ページから見た相対パスを返す
  saveDroppedFiles(pagePath: string, paths: string[]): Promise<string[]> // ウィンドウに落とされたファイル(OS のパス)を保存する。落とされたファイル以外は読まない
  pasteClipboardFiles(pagePath: string, stem: string): Promise<string[]> // OS のクリップボードのファイルや画像を直接読んで保存する(貼り付けのイベントにファイルが届かなかったとき)。なければ空
  saveFile(folder: string, name: string, bytes: Uint8Array): Promise<string> // 保管庫の中のフォルダ(「添付/2026-11-17」など)にファイルを保存し、保管庫から見た path を返す。途中のフォルダは作る。同じ名前があれば「 2」から番号を付ける(上書きしない)。.md は作れない(notAPage)
  savePage(folder: string, title: string, content: string): Promise<string> // 保管庫の中のフォルダ(「メモ/2026-11-17」など)に新しいページ「title.md」を content で作り、保管庫から見た path を返す。途中のフォルダは作る。同じ名前があれば「 2」から番号を付ける(上書きしない)
  readClipboardFiles(stem: string): Promise<PickedFile[]> // OS のクリップボードのファイルや画像を読むだけ(保存しない)。なければ空。stem は画像のデータに付ける名前
  readDroppedFiles(paths: string[]): Promise<PickedFile[]> // ウィンドウに落とされたファイルを読むだけ(保存しない)。落とされたファイル以外は読まない
  openAttachment(pagePath: string, src: string): Promise<void> // ページ内の相対パスのファイルを、Mac で決まっているアプリで開く(開くと動くものは Finder で見せる)
  movePage(path: string, parentPath: string | null): Promise<PageMeta> // 子ページごと parentPath の中へ動かす。リンクも書き換わる
  moveFolder(path: string, parentPath: string | null): Promise<string> // 中身ごと動かし、新しい path を返す。リンクも書き換わる
  search(query: string, limit: number): Promise<SearchHit[]>
  recentPages(limit: number): Promise<PageMeta[]>
  captureToInbox(text: string): Promise<void>
  assetUrl(pagePath: string, src: string): string | null // ページ内の相対パスを表示用URLに。保管庫の外なら null
  onExternalChange(cb: () => void): () => void
  openExternalUrl(url: string): Promise<void> // ページの外のリンク(http・https・mailto だけ)を既定のブラウザなどで開く。ほかの形は BackendError('invalidPath')
}

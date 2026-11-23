import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { backend } from '@/backend'
import { errorText } from '@/lib/error-text'
import { encodeLinkDestination, hasScheme } from '@/lib/paths'
import { isTauri } from '@/lib/platform'
import { useApp } from '@/store/app'
import { currentImagePagePath, preloadImageSize } from './plugins'
import { trackPosition } from './tracked-pos'

// 画像や PDF・HTML などのファイルを ⌘V で貼り付けたり、Finder からドラッグで落としたりすると、ページの子フォルダ
// (ページと同じ名前のフォルダ)に保存して、その場所に入れる。画像は画像として、ほかのファイルはファイル名のリンクとして入れる。
// ページを移動すると、ファイルも子フォルダごと一緒に動く。ファイルのリンクを押すと、Mac で決まっているアプリで開く。
// アプリでは、Finder から落としたファイルは画面に届かない(Tauri が受け取る)。Tauri のドロップのイベントで場所を知り、本体に保存してもらう。
// ⌘V でページにファイルが届かないとき(Finder でコピーしたファイルなど)は、OS のクリップボードを本体に直接読んでもらう。
// 保存を待つ間に文書が編集されても、入れる位置はずれない(tracked-pos)。

/** 1つのファイルの大きさの上限。これより大きいものは入れずに知らせる */
const MAX_BYTES = 100 * 1024 * 1024

/** スクリーンショットなど、名前のない画像に付ける名前(日時) */
function defaultName(type: string): string {
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `画像 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${ext}`
}

/** Markdown のリンク先として書ける形にする(空白や括弧を %XX に) */
export const encodeSrc = (path: string) => path.replace(/[\s()<>[\]%]/g, (c) => encodeURIComponent(c))

/** 画像として(本文に絵を出して)入れるファイル */
export const IMAGE_PATH = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|avif)$/i

/** 貼り付け・ドロップで届いたファイル。files が空でも items には入っていることがある(WebKit) */
function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const files = Array.from(data.files)
  if (files.length > 0) return files
  return Array.from(data.items, (item) => (item.kind === 'file' ? item.getAsFile() : null)).filter((f): f is File => !!f)
}

const FILE_NAME = /^[^\n/]+\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|avif|pdf|html?|txt|md|csv|json|rtf|docx?|xlsx?|pptx?|pages|numbers|key|zip|mp3|m4a|wav|mp4|mov)$/i

/**
 * ファイルが届かなかった貼り付けのうち、OS のクリップボードを直接読むべきもの。
 * Finder でコピーしたファイル(届くのはファイル名の文字だけのことがある)や、文字のないコピー(画像のデータだけ)
 */
function mayHoldFile(data: DataTransfer): boolean {
  const text = data.getData('text/plain').trim()
  // 画像のデータだけがあるとき(スクリーンショットなど)は、File として届かなくても image/ の型が立つことがある
  const hasImageType = data.types.some((t) => t.startsWith('image/'))
  return data.types.includes('Files') || data.types.includes('text/uri-list') || hasImageType || text === '' || FILE_NAME.test(text)
}

/** 保存したファイルの名前(相対パスの最後) */
const fileName = (src: string) => src.split('/').at(-1) ?? src

/** 保存したファイルを入れるブロック。画像はまとめて1つの段落に、ほかのファイルは1つずつ、ファイル名のリンクだけの段落にする */
function fileBlocks(view: EditorView, srcs: string[]): PMNode[] {
  const { schema } = view.state
  const images = srcs.filter((src) => IMAGE_PATH.test(src)).map((src) => schema.nodes.image.create({ src: encodeSrc(src), alt: '', title: '' }))
  const links = srcs
    .filter((src) => !IMAGE_PATH.test(src))
    .map((src) => schema.nodes.paragraph.create(null, schema.text(fileName(src), [schema.marks.link.create({ href: encodeLinkDestination(src), title: null })])))
  return [...(images.length > 0 ? [schema.nodes.paragraph.create(null, images)] : []), ...links]
}

/** ファイルを保存して(save)、pos(追い続ける)の位置に入れる。何も保存しなかったら、otherwise を呼ぶ */
async function placeFiles(view: EditorView, pos: number, save: (pagePath: string) => Promise<string[]>, otherwise?: (at: number) => void): Promise<void> {
  const pagePath = currentImagePagePath()
  const tracked = trackPosition(view, pos)
  let srcs: string[] = []
  try {
    srcs = await save(pagePath)
  } catch (e) {
    useApp.getState().showNotice({ tone: 'warning', title: 'ファイルを保存できませんでした', body: errorText('saveAttachment', e), actions: [] })
  }
  await Promise.all(srcs.filter((src) => IMAGE_PATH.test(src)).map((src) => preloadImageSize(pagePath, encodeSrc(src))))
  const at = tracked.release()
  if (at === null || view.isDestroyed || currentImagePagePath() !== pagePath) return
  if (srcs.length === 0) {
    otherwise?.(at)
    return
  }
  const blocks = fileBlocks(view, srcs)
  // 独立した行にする。空の行ならその行と置き換え、文字のある行ならその下に、それ以外の場所ならそこに入れる
  const $at = view.state.doc.resolve(at)
  const { tr } = view.state
  const { paragraph } = view.state.schema.nodes
  if ($at.parent.type === paragraph && $at.parent.content.size === 0 && $at.depth > 0) tr.replaceWith($at.before(), $at.after(), blocks)
  else if ($at.parent.inlineContent && $at.depth > 0) tr.insert($at.after(), blocks)
  else tr.insert(at, blocks)
  view.dispatch(tr.scrollIntoView())
}

/** 届いたファイルを保存する。大きすぎるものは知らせて除く */
const saveFiles = (files: File[]) => async (pagePath: string) => {
  const srcs: string[] = []
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      useApp.getState().showNotice({ tone: 'warning', title: 'ファイルが大きすぎます', body: `${file.name} は 100MB を超えるため、入れませんでした。`, actions: [] })
      continue
    }
    // スクリーンショットの貼り付けは「image.png」という名前で届くので、日時の名前にする
    const name = file.name && file.name !== 'image.png' ? file.name : file.type.startsWith('image/') ? defaultName(file.type) : 'ファイル'
    srcs.push(await backend().saveAttachment(pagePath, name, new Uint8Array(await file.arrayBuffer())))
  }
  return srcs
}

export const filePaste = $prose(
  () =>
    new Plugin({
      props: {
        handlePaste: (view, event) => {
          const data = event.clipboardData
          if (!data || view.state.selection.$from.parent.type.spec.code) return false
          const files = filesOf(data)
          if (files.length === 0 && !(isTauri && mayHoldFile(data))) return false
          event.preventDefault()
          // 選んでいる文字は消してから、その場所に入れる。画像やブロックを丸ごと選んでいるときは、消さずにその下へ入れる
          // (本文を押したつもりで画像が選ばれていることがあり、貼ると画像が置き換わって消えてしまうので)
          const { selection } = view.state
          if (selection instanceof NodeSelection) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(selection.to))))
          else if (!selection.empty) view.dispatch(view.state.tr.deleteSelection())
          const at = view.state.selection.from
          const text = data.getData('text/plain')
          // アプリ(macOS)では、WebKit がクリップボードの画像(スクリーンショットなど)を File として渡すかどうかが
          // 不安定なので、WebKit の File は当てにせず、常に OS のクリップボードを本体に直接読ませる。
          // 本体は Finder でコピーしたファイルも画像のデータも網羅し、ブラウザで出せない TIFF は PNG に直す。
          if (isTauri) {
            const stem = defaultName('image/png').replace(/\.png$/, '')
            void placeFiles(
              view,
              at,
              (pagePath) => backend().pasteClipboardFiles(pagePath, stem),
              // 本体が何も取れなかったとき: WebKit が File を持っていればそれで保存、なければ届いた文字を入れる
              (pos) => {
                if (files.length > 0) void placeFiles(view, pos, saveFiles(files))
                else if (text) view.dispatch(view.state.tr.insertText(text, pos).scrollIntoView())
              },
            )
            return true
          }
          // Web ビルド: 本体を呼べないので、WebKit が渡した File を使う
          if (files.length > 0) {
            void placeFiles(view, at, saveFiles(files))
            return true
          }
          return false
        },
        handleDrop: (view, event) => {
          const files = filesOf(event.dataTransfer)
          if (files.length === 0) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (!at) return false
          event.preventDefault()
          void placeFiles(view, at.pos, saveFiles(files))
          return true
        },
      },
    }),
)

// ---- アプリでのドロップ(Tauri のドロップのイベント) ----

const dropKey = new PluginKey<DecorationSet>('jot-file-drop')

/** ウィンドウの中の位置(物理ピクセル)にある本文の位置。本文の外なら null */
function posAt(view: EditorView, position: { x: number; y: number }): number | null {
  const scale = window.devicePixelRatio || 1
  return view.posAtCoords({ left: position.x / scale, top: position.y / scale })?.pos ?? null
}

/** 落とすとファイルが入る場所の印(入る行に下線を引く) */
function dropMark(view: EditorView, pos: number | null): DecorationSet {
  if (pos === null) return DecorationSet.empty
  const $pos = view.state.doc.resolve(pos)
  let from: number | null = null
  let node = null
  if ($pos.parent.isTextblock && $pos.depth > 0) {
    from = $pos.before()
    node = $pos.parent
  } else if ($pos.nodeBefore) {
    from = pos - $pos.nodeBefore.nodeSize
    node = $pos.nodeBefore
  }
  if (from === null || !node) return DecorationSet.empty
  return DecorationSet.create(view.state.doc, [Decoration.node(from, from + node.nodeSize, { class: 'file-drop-target' })])
}

export const fileDrop = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: dropKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => (tr.getMeta(dropKey) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
      },
      props: { decorations: (state) => dropKey.getState(state) },
      view: (view) => {
        if (!isTauri) return {}
        let dragging = false
        let destroyed = false
        const mark = (set: DecorationSet) => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(dropKey, set).setMeta('addToHistory', false))
        }
        const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === 'enter') dragging = payload.paths.length > 0
          if (!dragging) return
          if (payload.type === 'enter' || payload.type === 'over') mark(dropMark(view, posAt(view, payload.position)))
          else if (payload.type === 'leave') mark(DecorationSet.empty)
          else if (payload.type === 'drop') {
            mark(DecorationSet.empty)
            const at = posAt(view, payload.position)
            const { paths } = payload
            dragging = false
            if (at === null || paths.length === 0) return
            view.focus()
            void placeFiles(view, at, (pagePath) => backend().saveDroppedFiles(pagePath, paths))
          }
        })
        return {
          destroy: () => {
            if (destroyed) return
            destroyed = true
            void unlisten.then((off) => off())
          },
        }
      },
    }),
)

// ---- ファイルのリンク ----
// 保管庫の中の、ページ(.md)でないファイルへのリンクは、ファイルの印を付けて出し、押すと Mac で決まっているアプリで開く
// (PDF ならプレビュー、HTML ならブラウザ)。開くと動いてしまう種類のファイルは、本体が Finder で場所を見せるだけにする。

/** 保管庫の中のファイル(ページでないもの)を指すリンクか */
export const isFileHref = (href: string) => href !== '' && !hasScheme(href) && !href.startsWith('#') && !/\.md(#.*)?$/i.test(href)

function fileLinkDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const link = node.marks.find((m) => m.type.name === 'link')
    if (link && isFileHref(String(link.attrs.href))) decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'file-link' }))
    return false
  })
  return DecorationSet.create(doc, decorations)
}

const fileLinkKey = new PluginKey<DecorationSet>('jot-file-link')

export const attachmentLinks = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: fileLinkKey,
      state: {
        init: (_, { doc }) => fileLinkDecorations(doc),
        apply: (tr, set) => (tr.docChanged ? fileLinkDecorations(tr.doc) : set),
      },
      props: {
        decorations: (state) => fileLinkKey.getState(state),
        // 押したら開く(Shift で範囲を選ぶときは開かない)
        handleClick: (_view, _pos, event) => {
          const mark = event.target instanceof Element ? event.target.closest('.file-link') : null
          if (event.button !== 0 || event.shiftKey || !mark) return false
          // 印(span)はリンク(a)の中にも外にもなりうる
          const href = (mark.closest('a') ?? mark.querySelector('a'))?.getAttribute('href') ?? ''
          if (!isFileHref(href)) return false
          backend()
            .openAttachment(currentImagePagePath(), href)
            .catch((e: unknown) =>
              useApp.getState().showNotice({ tone: 'warning', title: 'ファイルを開けませんでした', body: e instanceof Error ? e.message : String(e), actions: [] }),
            )
          return true
        },
      },
    }),
)

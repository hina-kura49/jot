import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose, $view } from '@milkdown/kit/utils'
import { codeWindowView } from './code-window'

// Mermaid の図。言語が mermaid のコードブロックは、原文の下に図を描く。
// - 入力位置がブロックの外にあるときは図だけを見せ、図を押すと原文が開いて書ける(Obsidian と同じ)
// - 原文が書きかけで描けないときは、原文を開いたまま、直前に描けた図と理由を出す
// - Mermaid は大きい(数 MB)ので、図のあるページを初めて開いたときに読み込む。アプリの起動は遅くならない
// - 描いた図は原文ごとに覚えておき、同じ図はすぐに出す(ページの開き直しや元に戻すで、ちらつかない)

export const isMermaid = (node: PMNode) => node.type.name === 'code_block' && String(node.attrs.language).toLowerCase() === 'mermaid'

/** 書いている途中は、手が止まってから描き直す */
const RENDER_DELAY_MS = 250

const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

type Mermaid = (typeof import('mermaid'))['default']
let loading: Promise<Mermaid> | null = null
let loadedTheme: 'dark' | 'default' | null = null

/** Mermaid を読み込み、いまの明るさに合わせた見た目にする */
async function mermaidFor(theme: 'dark' | 'default'): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  const mermaid = await loading
  if (loadedTheme !== theme) {
    loadedTheme = theme
    mermaid.initialize({
      startOnLoad: false,
      // 図の中の文字は HTML として扱わない(リンクやスクリプトを動かさない)
      securityLevel: 'strict',
      theme,
      fontFamily: getComputedStyle(document.body).fontFamily,
    })
  }
  return mermaid
}

/** 原文と明るさ → 描いた SVG。描けなかったものは覚えない */
const svgCache = new Map<string, string>()
let seq = 0
/** Mermaid は同時に2つ描くと壊れることがあるので、1つずつ順に描く */
let queue: Promise<unknown> = Promise.resolve()

export function renderMermaid(source: string): Promise<string> {
  const theme = dark() ? 'dark' : 'default'
  const key = `${theme}\n${source}`
  const cached = svgCache.get(key)
  if (cached) return Promise.resolve(cached)
  const job = queue.then(async () => {
    const mermaid = await mermaidFor(theme)
    const { svg } = await mermaid.render(`jot-mermaid-${++seq}`, source)
    svgCache.set(key, svg)
    return svg
  })
  queue = job.catch(() => undefined)
  return job
}

/** 描けなかった理由を、短い1行にする */
function errorLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  const first = text.split('\n').find((l) => l.trim()) ?? ''
  return first.length > 160 ? `${first.slice(0, 160)}…` : first
}

/** 元のコードブロックと同じ形(pre > code)を作る */
function codeDom(language: string): { pre: HTMLElement; code: HTMLElement } {
  const pre = document.createElement('pre')
  if (language) pre.dataset.language = language
  const code = document.createElement('code')
  pre.append(code)
  return { pre, code }
}

export const mermaidView = $view(codeBlockSchema.node, () => (initial, view, getPos) => {
  const language = String(initial.attrs.language ?? '')
  // ふつうのコードは「窓」の形で描く(言語を mermaid に書き換えたら、図のブロックとして作り直す)
  if (!isMermaid(initial)) return codeWindowView(initial, view, getPos, (next) => !isMermaid(next))

  const dom = document.createElement('div')
  dom.className = 'mermaid-block'
  const { pre, code } = codeDom(language)
  const figure = document.createElement('div')
  figure.className = 'mermaid-view'
  figure.contentEditable = 'false'
  const diagram = document.createElement('div')
  diagram.className = 'mermaid-diagram'
  const error = document.createElement('div')
  error.className = 'mermaid-error'
  figure.append(diagram, error)
  dom.append(pre, figure)

  // 図を押したら、原文の末尾に入力位置を置いて書けるようにする
  figure.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const pos = getPos()
    if (pos === undefined) return
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1)))
    view.focus()
  })

  let source: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  const show = (text: string) => {
    const mine = text
    if (!text.trim()) {
      diagram.replaceChildren()
      dom.classList.add('mermaid-empty')
      dom.classList.remove('mermaid-failed')
      return
    }
    dom.classList.remove('mermaid-empty')
    renderMermaid(text).then(
      (svg) => {
        if (destroyed || source !== mine) return
        diagram.innerHTML = svg
        dom.classList.remove('mermaid-failed')
        error.textContent = ''
      },
      (e: unknown) => {
        if (destroyed || source !== mine) return
        // 直前に描けた図は残し、理由を添える
        dom.classList.add('mermaid-failed')
        error.textContent = `図を描けません: ${errorLine(e)}`
      },
    )
  }

  const schedule = (text: string, now: boolean) => {
    if (text === source) return
    source = text
    clearTimeout(timer)
    // 覚えている図はすぐに出す
    const cached = svgCache.has(`${dark() ? 'dark' : 'default'}\n${text}`)
    if (now || cached) show(text)
    else timer = setTimeout(() => show(text), RENDER_DELAY_MS)
  }
  schedule(initial.textContent, true)

  // OS の明るさが変わったら、その色で描き直す
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => {
    const text = source
    source = null
    if (text !== null) schedule(text, true)
  }
  scheme.addEventListener('change', onScheme)

  return {
    dom,
    contentDOM: code,
    update: (next) => {
      if (next.type !== initial.type || !isMermaid(next)) return false
      schedule(next.textContent, false)
      return true
    },
    // 図の中身は自分で書き換えたもの
    ignoreMutation: (m) => figure.contains(m.target) || (m.type === 'attributes' && m.target === dom),
    stopEvent: (e) => figure.contains(e.target as Node),
    destroy: () => {
      destroyed = true
      clearTimeout(timer)
      scheme.removeEventListener('change', onScheme)
    },
  }
})

// 入力位置(または選んでいる範囲)が図のブロックの中にあるときだけ、原文を見せる
const editingKey = new PluginKey<DecorationSet>('jot-mermaid-editing')

export function editingDecorations(state: { doc: PMNode; selection: { from: number; to: number } }): DecorationSet {
  const { doc, selection } = state
  const decorations: Decoration[] = []
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    // ブロックごと選んだとき(つまみで動かすときなど)は図のまま
    const inside = selection.from > pos && selection.to < pos + node.nodeSize
    if (inside && isMermaid(node)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mermaid-editing' }))
    return !node.isTextblock
  })
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

export const mermaidEditing = $prose(
  () =>
    new Plugin({
      key: editingKey,
      props: { decorations: (state) => editingDecorations(state) },
    }),
)

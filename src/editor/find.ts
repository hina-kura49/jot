import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

// ページの中を探す(⌘F)。当たったところに色を付け、いまの1つを濃くする。
// 大文字小文字は区別しない。探す語や文書が変わるたびに、文書を一度なめて当たりを数え直す。

export type FindState = { query: string; matches: { from: number; to: number }[]; current: number }
type Meta = { query: string } | { current: number }

const key = new PluginKey<FindState>('jot-find')
/** Vim のモードが、探す欄を閉じたこと(と探していた語)を知るため */
export const findPluginKey = key
const EMPTY: FindState = { query: '', matches: [], current: 0 }

/** 当たりが変わったとき(文書の編集でも)に呼ぶ。探す欄の数の表示を合わせる */
let onChange: (() => void) | null = null
export const setFindListener = (fn: (() => void) | null) => {
  onChange = fn
}

/** 文書の中で query に当たる範囲(文書の位置)。段落の中の文字だけを探す(段落をまたいでは当てない) */
export function findMatches(doc: PMNode, query: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!query) return out
  const needle = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // 段落の中の文字をつなぎ、つないだ文字の位置 → 文書の位置の対応を持つ
    let text = ''
    const starts: { at: number; pos: number }[] = []
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) {
        text += '￼' // 文字でない部品(画像など)は、当たらない1文字にする
        return
      }
      starts.push({ at: text.length, pos: pos + 1 + offset })
      text += child.text
    })
    const lower = text.toLowerCase()
    // 小文字にすると長さが変わる文字がある段落は、大文字小文字を区別して探す(位置がずれないように)
    const [hay, word] = lower.length === text.length ? [lower, needle] : [text, query]
    const toPos = (i: number) => {
      let s = starts[0]
      for (const x of starts) if (x.at <= i) s = x
      return s.pos + (i - s.at)
    }
    for (let i = hay.indexOf(word); i !== -1 && starts.length > 0; i = hay.indexOf(word, i + Math.max(1, word.length))) {
      out.push({ from: toPos(i), to: toPos(i + word.length - 1) + 1 })
    }
    return false
  })
  return out
}

export const findPlugin = $prose(
  () =>
    new Plugin<FindState>({
      key,
      state: {
        init: () => EMPTY,
        apply(tr, prev) {
          const meta = tr.getMeta(key) as Meta | undefined
          if (meta && 'query' in meta) {
            const matches = findMatches(tr.doc, meta.query)
            // 入力位置より後ろの最初の当たりから始める
            const head = tr.selection.from
            const current = Math.max(0, matches.findIndex((m) => m.from >= head))
            return { query: meta.query, matches, current: matches.length > 0 && current < matches.length ? current : 0 }
          }
          if (meta && 'current' in meta) return { ...prev, current: meta.current }
          if (tr.docChanged && prev.query) {
            const matches = findMatches(tr.doc, prev.query)
            return { ...prev, matches, current: Math.min(prev.current, Math.max(0, matches.length - 1)) }
          }
          return prev
        },
      },
      view: () => ({
        update: (view, prev) => {
          if (key.getState(view.state) !== key.getState(prev)) onChange?.()
        },
      }),
      props: {
        decorations(state) {
          const find = key.getState(state)
          if (!find || find.matches.length === 0) return null
          return DecorationSet.create(
            state.doc,
            find.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === find.current ? 'find-hit find-hit-current' : 'find-hit' })),
          )
        },
      },
    }),
)

export const findState = (view: EditorView): FindState => key.getState(view.state) ?? EMPTY

/** いまの当たりが見えるようにスクロールする(入力位置は動かさない。探す欄に打ち続けられるように) */
function reveal(view: EditorView): void {
  const { matches, current } = findState(view)
  const match = matches[current]
  if (!match) return
  const dom = view.domAtPos(match.from)
  const el = dom.node instanceof Element ? dom.node : dom.node.parentElement
  el?.scrollIntoView({ block: 'center', behavior: 'instant' })
}

export function setFindQuery(view: EditorView, query: string): void {
  view.dispatch(view.state.tr.setMeta(key, { query } satisfies Meta).setMeta('addToHistory', false))
  reveal(view)
}

/** 次(1)・前(-1)の当たりへ。端まで行ったら反対の端へ回る */
export function findStep(view: EditorView, dir: 1 | -1): void {
  const { matches, current } = findState(view)
  if (matches.length === 0) return
  const next = (current + dir + matches.length) % matches.length
  view.dispatch(view.state.tr.setMeta(key, { current: next } satisfies Meta).setMeta('addToHistory', false))
  reveal(view)
}

/** 探すのをやめる。select なら、いまの当たりを選んだ状態でエディタに戻る */
export function closeFind(view: EditorView, select: boolean): void {
  const { matches, current } = findState(view)
  const match = matches[current]
  const tr = view.state.tr.setMeta(key, { query: '' } satisfies Meta).setMeta('addToHistory', false)
  if (select && match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView()
  view.dispatch(tr)
  view.focus()
}

import { InputRule, wrappingInputRule } from '@milkdown/kit/prose/inputrules'
import { findWrapping } from '@milkdown/kit/prose/transform'
import { blockquoteSchema } from '@milkdown/kit/preset/commonmark'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

// ---- Notion の Markdown ショートカットのうち、Milkdown の既定にないもの ----
// 既定のまま使うもの: `# ` `## ` `### `(見出し)、`- ` `* ` `+ `(リスト)、`1. `(番号付き)、`> `(引用)、
// ```(コード)、リストの中の `[ ] `(チェック項目)。`---`(区切り線)は下の hrInputRule に置き換える。
// `> ` は Notion ではトグルだが、このエディタでは引用のまま(保存する Markdown でも `>` は引用のため)。
// 入力の規則は IME の変換中の文字には反応しない(確定してから判定する)。

/** 行頭で `[] `(または `[ ] ` / `[x] `)を打つと、チェックリストになる。リストの中では Milkdown の既定の規則が受け持つ */
export const todoInputRule = $inputRule(
  () =>
    new InputRule(/^\[( ?|x|X)\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start)
      for (let d = $start.depth; d > 0; d--) if ($start.node(d).type.name === 'list_item') return null
      if ($start.parent.type.name !== 'paragraph') return null
      const { schema } = state
      const tr = state.tr.delete(start, end)
      const range = tr.doc.resolve(start).blockRange()
      const wrapping = range && findWrapping(range, schema.nodes.bullet_list)
      if (!range || !wrapping) return null
      tr.wrap(range, wrapping)
      const item = tr.doc.nodeAt(range.start + 1)
      if (!item || item.type.name !== 'list_item') return null
      tr.setNodeMarkup(range.start + 1, undefined, { ...item.attrs, checked: match[1].toLowerCase() === 'x' })
      return tr
    }),
)

/** 行頭で `" ` を打つと、引用になる(Notion と同じ) */
export const quoteInputRule = $inputRule((ctx) => wrappingInputRule(/^\s*"\s$/, blockquoteSchema.type(ctx)))

/**
 * 行頭で `---` を打つと、その行が区切り線になり、入力位置は区切り線の次の行へ移る(Notion と同じ)。
 * Milkdown の既定の規則は区切り線そのものを選んだ状態にし、最後の行では次の行も作らないので、
 * 入力位置がなくなって画面が先頭へ飛んでいた。そのため markdown.ts で既定の規則を外し、これを使う
 */
export const hrInputRule = $inputRule(
  () =>
    new InputRule(/^---$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start)
      if ($start.parent.type.name !== 'paragraph' || $start.parent.content.size !== end - start) return null
      const { schema } = state
      const hr = schema.nodes.hr.create()
      const block = { from: $start.before(), to: $start.after() }
      const container = $start.node($start.depth - 1)
      const index = $start.index($start.depth - 1)
      if (!container.canReplaceWith(index, index + 1, hr.type)) return null
      const tr = state.tr.replaceWith(block.from, block.to, hr)
      const after = block.from + hr.nodeSize
      if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, schema.nodes.paragraph.create())
      return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
    }),
)

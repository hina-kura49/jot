import { keymap } from '@milkdown/kit/prose/keymap'
import { listItemSchema } from '@milkdown/kit/preset/commonmark'
import { chainCommands } from '@milkdown/kit/prose/commands'
import { Fragment, type NodeType } from '@milkdown/kit/prose/model'
import { liftListItem } from '@milkdown/kit/prose/schema-list'
import { Selection, TextSelection, type Command } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { useApp } from '@/store/app'
import { moveCurrentBlock } from './block-move'
import { activeSession } from './registry'

/**
 * Milkdown の既定に加えるショートカット(デザイン 9)。行内のコード(⌘E)は Milkdown の既定のまま使う。
 * ProseMirror は IME の変換中のキーをショートカットとして扱わないので、変換中は反応しない。
 */
export const extraKeys = $prose((ctx) =>
  keymap({
    // リストの項目の先頭で Backspace を押したら、Notion と同じく上の行とつなげずに印を外す(入れ子なら1段浅くする)
    // コードブロック・数式の先頭で Backspace を押したら、ふつうの段落に戻す(ページの先頭にあっても消せるように)
    Backspace: chainCommands(liftAtListStart(() => listItemSchema.type(ctx)), unwrapCodeAtStart),
    // ブロック・リストの項目の並べ替え(ドラッグのキーボード版)
    'Mod-Shift-ArrowUp': (_state, _dispatch, view) => (view ? moveCurrentBlock(view, -1) : false),
    'Mod-Shift-ArrowDown': (_state, _dispatch, view) => (view ? moveCurrentBlock(view, 1) : false),
    // 本文の最初の行で ↑ を押したら、タイトルへ(キーボードだけで名前を変えられるように)
    ArrowUp: (state, _dispatch, view) => {
      const { selection } = state
      // 文書の最初のテキストの、最初の行にいるときだけ
      const first = Selection.atStart(state.doc).$head
      if (!view || !selection.empty || selection.$head.start() !== first.start() || !view.endOfTextblock('up')) return false
      const current = activeSession()?.current()
      if (!current) return false
      useApp.getState().focusTitle(current.path)
      return true
    },
  }),
)

/** リストの項目の最初の段落の先頭にいるときだけ、項目を持ち上げる。それ以外は既定の Backspace に任せる */
export function liftAtListStart(listItem: () => NodeType): Command {
  return (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.empty) return false
    const { $from } = selection
    if ($from.parentOffset !== 0 || $from.depth < 2) return false
    if ($from.node(-1).type !== listItem() || $from.index(-1) !== 0) return false
    return liftListItem(listItem())(state, dispatch)
  }
}

/**
 * コードのブロック(コードブロック・Mermaid の図・数式)の先頭で Backspace を押したら、ブロックをやめて段落に戻す(Notion と同じ)。
 * 中身は1行ずつ段落になり、空のブロックは空の段落1つになる。もう一度 Backspace を押せば、その行も消える。
 * 既定の Backspace は上のブロックとつなげようとするだけなので、ページの先頭や区切り線の下にあるコードブロックは消せなかった
 */
export const unwrapCodeAtStart: Command = (state, dispatch) => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const { $from } = selection
  if (!$from.parent.type.spec.code || $from.parentOffset !== 0 || $from.depth === 0) return false
  const { paragraph } = state.schema.nodes
  const lines = $from.parent.textContent.split('\n')
  const blocks = Fragment.fromArray(lines.map((line) => paragraph.create(null, line ? state.schema.text(line) : null)))
  const container = $from.node($from.depth - 1)
  const index = $from.index($from.depth - 1)
  if (!container.canReplace(index, index + 1, blocks)) return false
  if (dispatch) {
    const start = $from.before()
    const tr = state.tr.replaceWith(start, $from.after(), blocks)
    dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView())
  }
  return true
}

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Selection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

// 本文の下の空白をクリックしたとき(Notion と同じ動き)。
// 最後のブロックが文章を打てる段落・見出しならその末尾へ、そうでなければ(リスト・コード・表・画像など)
// 下に空の段落を足してそこへ入力位置を置く。

/** 末尾にそのまま続けて打てるブロックか。画像だけの段落は打つ場所ではないので除く */
const typable = (node: PMNode | null): boolean => {
  if (!node || !['paragraph', 'heading'].includes(node.type.name)) return false
  let onlyImages = node.childCount > 0
  node.forEach((child) => {
    if (child.type.name !== 'image') onlyImages = false
  })
  return !onlyImages
}

export function focusEnd(view: EditorView): void {
  if (!view.editable) return
  const { doc, schema } = view.state
  let tr = view.state.tr
  if (!typable(doc.lastChild)) tr = tr.insert(doc.content.size, schema.nodes.paragraph.create())
  view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)).scrollIntoView())
  view.focus()
}

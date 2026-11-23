// @vitest-environment jsdom
import { Editor, editorViewCtx } from '@milkdown/kit/core'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hrInputRule, quoteInputRule, todoInputRule } from '../input-rules'
import { configureMarkdown, loadMarkdown } from '../markdown'
import { SLASH_ITEMS, type SlashIcon } from '../slash'

let editor: Editor
let view: EditorView

beforeEach(async () => {
  editor = await configureMarkdown(Editor.make()).use(todoInputRule).use(quoteInputRule).use(hrInputRule).create()
  view = editor.action((ctx) => ctx.get(editorViewCtx))
})
afterEach(async () => {
  await editor.destroy()
})

/** 空の行で、1文字ずつ打つ(入力の規則は打った文字ごとに判定される) */
function typeOnEmptyLine(text: string) {
  const { doc } = editor.action((ctx) => loadMarkdown(ctx, '\n'))
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

/** メニューに出すショートカットを打ったあとの、最初のブロック */
const EXPECTED: Partial<Record<SlashIcon, (view: EditorView) => boolean>> = {
  h1: (v) => v.state.doc.firstChild?.type.name === 'heading' && v.state.doc.firstChild.attrs.level === 1,
  h2: (v) => v.state.doc.firstChild?.type.name === 'heading' && v.state.doc.firstChild.attrs.level === 2,
  h3: (v) => v.state.doc.firstChild?.type.name === 'heading' && v.state.doc.firstChild.attrs.level === 3,
  bullet: (v) => v.state.doc.firstChild?.type.name === 'bullet_list',
  ordered: (v) => v.state.doc.firstChild?.type.name === 'ordered_list',
  task: (v) => v.state.doc.firstChild?.firstChild?.attrs.checked === false,
  quote: (v) => v.state.doc.firstChild?.type.name === 'blockquote',
  code: (v) => v.state.doc.firstChild?.type.name === 'code_block',
  table: (v) => v.state.doc.firstChild?.type.name === 'table' && v.state.doc.firstChild.childCount === 3 && v.state.doc.firstChild.firstChild?.childCount === 3,
  divider: (v) => v.state.doc.firstChild?.type.name === 'hr',
}

describe('スラッシュメニューに出すショートカット', () => {
  const items = SLASH_ITEMS.filter((i) => i.shortcut)

  it('ショートカットのある項目は、どれも確かめる対象になっている', () => {
    expect(items.map((i) => i.id).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(items.map((i) => [i.label, i] as const))('%s: 行頭で打つと、メニューから選んだときと同じブロックになる', (_label, item) => {
    // 区切り線は打ち終えたところで変わる。ほかは、後ろの空白で変わる
    typeOnEmptyLine(item.id === 'divider' ? item.shortcut! : `${item.shortcut} `)
    expect(EXPECTED[item.id]?.(view)).toBe(true)
  })
})

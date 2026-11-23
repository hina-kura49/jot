// @vitest-environment jsdom
import { Editor, editorViewCtx } from '@milkdown/kit/core'
import { history, undoCommand } from '@milkdown/kit/plugin/history'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { callCommand } from '@milkdown/kit/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calloutKeys } from '../callout'
import { extraKeys } from '../keys'
import { configureMarkdown, loadMarkdown, serializeMarkdown, type SourceSnapshot } from '../markdown'

let editor: Editor
let view: EditorView

beforeEach(async () => {
  editor = await configureMarkdown(Editor.make()).use(history).use(calloutKeys).use(extraKeys).create()
  view = editor.action((ctx) => ctx.get(editorViewCtx))
})
afterEach(async () => {
  await editor.destroy()
})

let snapshot: SourceSnapshot
function setDoc(markdown: string) {
  const loaded = editor.action((ctx) => loadMarkdown(ctx, markdown))
  const { doc } = loaded
  snapshot = loaded.snapshot
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
}
const cursorAt = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
const pressKey = (key: string) => view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key })))
const types = () => {
  const out: string[] = []
  view.state.doc.forEach((n) => out.push(n.type.name))
  return out
}
/** 最初のコード系のブロックの先頭の位置 */
function codeStart(): number {
  let at = -1
  view.state.doc.descendants((n, pos) => {
    if (at < 0 && n.type.spec.code) at = pos + 1
    return at < 0
  })
  return at
}

const save = () => editor.action((ctx) => serializeMarkdown(ctx, view.state.doc, snapshot))
const texts = () => {
  const out: string[] = []
  view.state.doc.forEach((n) => out.push(n.textContent))
  return out
}

describe('コードブロックを Backspace で消す', () => {
  it('ページの先頭にある空のコードブロックは、先頭で Backspace を押すと空の段落に戻る', () => {
    setDoc('```\n```\n')
    cursorAt(codeStart())
    expect(pressKey('Backspace')).toBe(true)
    expect(types()).toEqual(['paragraph'])
    expect(view.state.selection.head).toBe(1)
    expect(save().trim()).toBe('')
  })

  it('区切り線の下の空のコードブロックも消せる(区切り線を選ぶだけで終わらない)', () => {
    setDoc('---\n\n```\n```\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    expect(types()).toEqual(['hr', 'paragraph'])
  })

  it('中身のあるコードブロックは、1行ずつ段落になる。言語の指定は残らない', () => {
    setDoc('```js\nconst a = 1\nconst b = 2\n```\n\nあと\n')
    cursorAt(codeStart())
    expect(pressKey('Backspace')).toBe(true)
    expect(types()).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(texts()).toEqual(['const a = 1', 'const b = 2', 'あと'])
    expect(save()).toBe('const a = 1\n\nconst b = 2\n\nあと\n')
  })

  it('段落の下のコードブロックは、上の段落とつながらずに段落へ戻る。もう一度押すと上の行とつながる', () => {
    setDoc('まえ\n\n```\n```\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    expect(types()).toEqual(['paragraph', 'paragraph'])
    pressKey('Backspace')
    expect(types()).toEqual(['paragraph'])
    expect(texts()).toEqual(['まえ'])
  })

  it('Mermaid の図と数式のブロックも、同じように消せる', () => {
    setDoc('```mermaid\nflowchart TD\n```\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    expect(types()).toEqual(['paragraph'])
    setDoc('$$\nx^2\n$$\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    expect(types()).toEqual(['paragraph'])
    expect(texts()).toEqual(['x^2'])
  })

  it('リストの中のコードブロックは、項目の中の段落になる', () => {
    setDoc('- a\n\n  ```\n  x\n  ```\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    expect(types()).toEqual(['bullet_list'])
    expect(save()).toBe('- a\n\n  x\n')
  })

  it('コードの途中や、範囲を選んでいるときは、既定の Backspace のまま', () => {
    setDoc('```\nabc\n```\n')
    cursorAt(codeStart() + 1)
    expect(pressKey('Backspace')).toBeFalsy()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, codeStart(), codeStart() + 2)))
    pressKey('Backspace')
    expect(types()).toEqual(['code_block'])
    expect(texts()).toEqual(['c'])
  })

  it('取り消すと、コードブロックに戻る', () => {
    setDoc('```js\nconst a = 1\n```\n')
    cursorAt(codeStart())
    pressKey('Backspace')
    editor.action(callCommand(undoCommand.key))
    expect(types()).toEqual(['code_block'])
    expect(view.state.doc.firstChild?.attrs.language).toBe('js')
  })
})

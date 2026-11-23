// @vitest-environment jsdom
import { Editor, editorViewCtx } from '@milkdown/kit/core'
import { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusEnd } from '../focus-end'
import { configureMarkdown, loadMarkdown } from '../markdown'

let editor: Editor
let view: EditorView

beforeEach(async () => {
  editor = await configureMarkdown(Editor.make()).create()
  view = editor.action((ctx) => ctx.get(editorViewCtx))
})
afterEach(async () => {
  await editor.destroy()
})

function setDoc(markdown: string) {
  const { doc } = editor.action((ctx) => loadMarkdown(ctx, markdown))
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
}

const lastTypes = () => {
  const types: string[] = []
  view.state.doc.forEach((n) => types.push(n.type.name))
  return types
}

describe('本文の下の空白を押したとき', () => {
  it('最後が段落なら、その末尾に入力位置を置き、ブロックは増やさない', () => {
    setDoc('一行目\n\n最後の行\n')
    focusEnd(view)
    expect(lastTypes()).toEqual(['paragraph', 'paragraph'])
    expect(view.state.selection.from).toBe(view.state.doc.content.size - 1)
  })

  it('最後が見出しなら、その末尾に置く', () => {
    setDoc('# 見出し\n')
    focusEnd(view)
    expect(lastTypes()).toEqual(['heading'])
    expect(view.state.selection.$from.parent.type.name).toBe('heading')
  })

  it('最後がリストやコードなら、下に空の段落を足してそこに置く', () => {
    for (const md of ['- 項目\n', '```\ncode\n```\n']) {
      setDoc(md)
      focusEnd(view)
      expect(lastTypes().at(-1)).toBe('paragraph')
      expect(view.state.selection.$from.parent.content.size).toBe(0)
    }
  })

  it('最後が画像だけの段落なら、下に空の段落を足す', () => {
    setDoc('![](a.png)\n')
    focusEnd(view)
    expect(lastTypes()).toEqual(['paragraph', 'paragraph'])
    expect(view.state.selection.$from.parent.content.size).toBe(0)
  })
})

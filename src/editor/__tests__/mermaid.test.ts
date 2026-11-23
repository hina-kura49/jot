// @vitest-environment jsdom
import { Editor, parserCtx } from '@milkdown/kit/core'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { describe, expect, it } from 'vitest'
import { configureMarkdown } from '../markdown'
import { editingDecorations, isMermaid } from '../mermaid'
import { roundTrip } from './helpers'

const MD = '前の段落\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst a = 1\n```\n'

async function parsed() {
  const editor = await configureMarkdown(Editor.make()).create()
  const doc = editor.action((ctx) => ctx.get(parserCtx)(MD))
  await editor.destroy()
  return doc
}

describe('Mermaid の図', () => {
  it('言語が mermaid のコードブロックだけを図として扱う', async () => {
    const doc = await parsed()
    expect([doc.child(1), doc.child(2)].map(isMermaid)).toEqual([true, false])
  })

  it('保存すると、元の ```mermaid のまま書き戻す', async () => {
    const { preserved } = await roundTrip(MD)
    expect(preserved).toBe(MD)
  })

  it('入力位置が図の原文の中にあるときだけ、原文を開く印を付ける', async () => {
    const doc = await parsed()
    const start = doc.child(0).nodeSize
    const count = (selection: TextSelection | NodeSelection) => editingDecorations({ doc, selection }).find().length
    expect(count(TextSelection.create(doc, start + 3))).toBe(1)
    expect(count(TextSelection.create(doc, 2))).toBe(0)
    // つまみでブロックごと選んだときは図のまま
    expect(count(NodeSelection.create(doc, start))).toBe(0)
  })
})

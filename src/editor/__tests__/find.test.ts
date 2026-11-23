import { Schema } from '@milkdown/kit/prose/model'
import { describe, expect, it } from 'vitest'
import { findMatches } from '../find'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true },
  },
  marks: { strong: {} },
})
const p = (...parts: (string | 'IMG' | { b: string })[]) =>
  schema.nodes.paragraph.create(
    null,
    parts.map((x) => (x === 'IMG' ? schema.nodes.image.create() : typeof x === 'string' ? schema.text(x) : schema.text(x.b, [schema.marks.strong.create()]))),
  )
const texts = (doc: ReturnType<typeof schema.nodes.doc.create>, q: string) => findMatches(doc, q).map((m) => doc.textBetween(m.from, m.to))

describe('findMatches', () => {
  it('大文字小文字を区別せず、すべての当たりを返す', () => {
    const doc = schema.nodes.doc.create(null, [p('Jot と jot'), p('JOT')])
    expect(texts(doc, 'jot')).toEqual(['Jot', 'jot', 'JOT'])
  })

  it('太字などで分かれた文字をまたいで当てる', () => {
    const doc = schema.nodes.doc.create(null, [p('メモ', { b: 'アプリ' }, 'です')])
    expect(texts(doc, 'モアプ')).toEqual(['モアプ'])
  })

  it('画像の後ろでも位置がずれない。段落をまたいでは当てない', () => {
    const doc = schema.nodes.doc.create(null, [p('あ', 'IMG', 'いう'), p('え')])
    expect(texts(doc, 'いう')).toEqual(['いう'])
    expect(texts(doc, 'うえ')).toEqual([])
  })

  it('空の語では何も返さない', () => {
    expect(findMatches(schema.nodes.doc.create(null, [p('a')]), '')).toEqual([])
  })
})

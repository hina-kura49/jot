// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Editor, editorViewCtx } from '@milkdown/kit/core'
import { history } from '@milkdown/kit/plugin/history'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calloutFold, calloutKeys, isClosed, toggleFold } from '../callout'
import { hrInputRule, quoteInputRule, todoInputRule } from '../input-rules'
import { configureMarkdown, loadMarkdown, serializeMarkdown, type SourceSnapshot } from '../markdown'
import { runBlockCommand, slashKey, slashPlugin, SLASH_ITEMS, type SlashIcon } from '../slash'
import { children, roundTrip, topLevelTypes, withChildren } from './helpers'

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', '12-callout-toggle.md'), 'utf8')

describe('コールアウトとトグルの読み込み', () => {
  it('Obsidian のコールアウトの書き方を、コールアウト・トグルとして読む', async () => {
    const found: { kind: string; meta: string; fold: string; title: string; body: number }[] = []
    await roundTrip(fixture, (doc) => {
      doc.descendants((n) => {
        if (n.type.name === 'callout') {
          found.push({ kind: n.attrs.kind, meta: n.attrs.meta, fold: n.attrs.fold, title: n.firstChild?.textContent ?? '', body: n.childCount - 1 })
        }
      })
      return doc
    })
    expect(found).toEqual([
      { kind: 'note', meta: '', fold: '', title: 'メモ', body: 1 },
      { kind: 'tip', meta: '', fold: '', title: '', body: 1 },
      { kind: 'warning', meta: '', fold: '', title: 'タイトルだけ', body: 1 }, // 本文は空の段落1つ
      { kind: 'note', meta: '', fold: '-', title: '閉じたトグル', body: 2 },
      { kind: 'note', meta: '', fold: '+', title: '開いたトグル', body: 1 },
      { kind: 'note', meta: 'h2', fold: '-', title: 'トグル見出し2', body: 1 },
      { kind: 'NOTE', meta: '', fold: '-', title: '太字のタイトル', body: 1 },
      { kind: 'note', meta: '', fold: '-', title: '入れ子のトグル', body: 1 },
    ])
  })

  it('普通の引用と、打ち消した `\\[!note]` は引用のまま。`$$` は数式のブロック、`$` 1つは文字のまま', async () => {
    const types = await topLevelTypes(fixture)
    expect(types.slice(-5)).toEqual(['blockquote', 'blockquote', 'hr', 'math_block', 'paragraph'])
  })
})

describe('コールアウトとトグルの書き出し', () => {
  const resave = async (src: string) =>
    (
      await roundTrip(src, (doc, { parse }) => withChildren(doc, [...parse('先頭。'), ...children(doc)]))
    ).preserved.replace(/^先頭。\n\n/, '')

  it('ほかのブロックを編集しても、コールアウトとトグルは原文のまま', async () => {
    const { preserved } = await roundTrip(fixture, (doc, { parse }) => withChildren(doc, [...children(doc), ...parse('追記。')]))
    expect(preserved).toBe(`${fixture}\n追記。\n`)
  })

  it.each([
    ['タイトルと本文', '> [!note] メモ\n> 本文。\n'],
    ['タイトルなし', '> [!tip]\n> 本文。\n'],
    ['タイトルだけ', '> [!warning] タイトルだけ\n'],
    ['閉じたトグルとリスト', '> [!note]- 閉じた\n> 中身。\n>\n> - 項目\n'],
    ['トグル見出し', '> [!note|h2]+ 見出し\n> 中身。\n'],
    ['入れ子', '> [!note]- 外\n> > [!note]- 内\n> > 中身。\n'],
    ['タイトルの直後のリスト', '> [!note]- 外\n> - 項目1\n> - 項目2\n'],
  ])('書き出し直しても同じ形になる: %s', async (_name, src) => {
    // 先頭に段落を足すと、原文の控えとの突き合わせは変わらないので、書き出し直しを確かめるため控えを使わない
    const editor = await configureMarkdown(Editor.make()).create()
    const out = editor.action((ctx) => {
      const { doc } = loadMarkdown(ctx, src)
      const empty: SourceSnapshot = { frontmatter: '', blocks: [], trailing: '' }
      return serializeMarkdown(ctx, doc, empty)
    })
    await editor.destroy()
    expect(out).toBe(src)
    expect(await resave(src)).toBe(src)
  })

  it('本文の先頭の `===` は、見出しの下線と読まれずに残る', async () => {
    const editor = await configureMarkdown(Editor.make()).create()
    const empty: SourceSnapshot = { frontmatter: '', blocks: [], trailing: '' }
    const body = editor.action((ctx) => {
      const out = serializeMarkdown(ctx, loadMarkdown(ctx, '> [!note] T\n>\n> ===\n').doc, empty)
      const callout = loadMarkdown(ctx, out).doc.child(0)
      return { type: callout.type.name, title: callout.child(0).textContent, body: callout.child(1).textContent }
    })
    await editor.destroy()
    expect(body).toEqual({ type: 'callout', title: 'T', body: '===' })
  })
})

// ---- エディタの中での操作 ----

let editor: Editor
let view: EditorView

beforeEach(async () => {
  editor = await configureMarkdown(Editor.make())
    .use(history)
    .use(slashPlugin)
    .use(calloutFold)
    .use(calloutKeys)
    .use(todoInputRule)
    .use(quoteInputRule)
    .use(hrInputRule)
    .create()
  view = editor.action((ctx) => ctx.get(editorViewCtx))
})
afterEach(async () => {
  await editor.destroy()
})

function setDoc(markdown: string): SourceSnapshot {
  const { doc, snapshot } = editor.action((ctx) => loadMarkdown(ctx, markdown))
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }))
  return snapshot
}
const save = (snapshot: SourceSnapshot) => editor.action((ctx) => serializeMarkdown(ctx, view.state.doc, snapshot))
const cursorAt = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
function typeText(text: string) {
  const { from, to } = view.state.selection
  const handled = view.someProp('handleTextInput', (f) => f(view, from, to, text, () => view.state.tr.insertText(text, from, to)))
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, to))
}
const pressKey = (key: string) => view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key })))

/** 空の行で「/」を打ち、id の項目を選ぶ */
function runSlash(id: SlashIcon) {
  typeText('/')
  const state = slashKey.getState(view.state)
  if (!state?.active) throw new Error('メニューが開いていない')
  const item = SLASH_ITEMS.find((i) => i.id === id)
  if (!item) throw new Error(`項目がない: ${id}`)
  editor.action((ctx) => runBlockCommand(ctx, view, item, state))
}
const first = (): PMNode => view.state.doc.child(0)

describe('スラッシュコマンド', () => {
  it('/toggle: 行の文字がタイトルのトグルになり、保存すると `> [!note]-` になる', () => {
    const snapshot = setDoc('議事録\n')
    cursorAt(1)
    runSlash('toggle')
    expect(first().type.name).toBe('callout')
    expect(first().attrs.fold).toBe('-')
    expect(view.state.selection.$from.parent.type.name).toBe('callout_title')
    expect(save(snapshot)).toBe('> [!note]- 議事録\n')
  })

  it('トグルのタイトルの末尾で Enter を押すと中身の1行目に移り、打った文字が中身として保存される', () => {
    const snapshot = setDoc('\n')
    cursorAt(1)
    runSlash('toggle')
    typeText('タイトル')
    pressKey('Enter') // 開いたトグル: 既定の動き(中身の先頭に段落を作る)
    view.dispatch(view.state.tr.split(view.state.selection.from))
    typeText('中身')
    const out = save(snapshot)
    expect(out).toContain('> [!note]- タイトル\n')
    expect(out).toContain('中身')
  })

  it('/toggle-h2: トグル見出しは `> [!note|h2]-`', () => {
    const snapshot = setDoc('\n')
    cursorAt(1)
    runSlash('toggle-h2')
    typeText('見出し')
    expect(save(snapshot)).toBe('> [!note|h2]- 見出し\n')
  })

  it('/callout: 行はそのまま本文になり、タイトルは空', () => {
    const snapshot = setDoc('大事なこと\n')
    cursorAt(1)
    runSlash('callout')
    expect(first().type.name).toBe('callout')
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(save(snapshot)).toBe('> [!note]\n> 大事なこと\n')
  })

  it('/divider: 空の行は区切り線になり、カーソルは次の行へ', () => {
    const snapshot = setDoc('上\n\n下\n')
    const secondStart = first().nodeSize
    view.dispatch(view.state.tr.insert(secondStart, view.state.schema.nodes.paragraph.create()))
    cursorAt(secondStart + 1)
    runSlash('divider')
    expect(children(view.state.doc).map((n) => n.type.name)).toEqual(['paragraph', 'hr', 'paragraph'])
    expect(view.state.selection.$from.parent.textContent).toBe('下')
    expect(save(snapshot)).toBe('上\n\n---\n\n下\n')
  })

  it('/math: 数式のブロックになり、`$$` で囲んで保存される', () => {
    const snapshot = setDoc('\n')
    cursorAt(1)
    runSlash('math')
    expect(first().type.name).toBe('math_block')
    typeText('E = mc^2')
    expect(save(snapshot)).toBe('$$\nE = mc^2\n$$\n')
  })
})

describe('トグルの開閉', () => {
  const src = '> [!note]- 閉じる\n> 中身A\n\n> [!note]+ 開く\n> 中身B\n'
  const secondPos = () => first().nodeSize

  it('読み込んだときは、- のトグルは閉じ、+ のトグルは開いている', () => {
    setDoc(src)
    expect(isClosed(view.state, 0)).toBe(true)
    expect(isClosed(view.state, secondPos())).toBe(false)
  })

  it('開閉はファイルに書かない(保存の結果は変わらない)', () => {
    const snapshot = setDoc(src)
    toggleFold(view, 0)
    toggleFold(view, secondPos())
    expect(isClosed(view.state, 0)).toBe(false)
    expect(isClosed(view.state, secondPos())).toBe(true)
    expect(save(snapshot)).toBe(src)
  })

  it('閉じるときに中身にカーソルがあれば、タイトルの行へ移す', () => {
    setDoc(src)
    const pos = secondPos()
    const second = view.state.doc.child(1)
    cursorAt(pos + 1 + second.firstChild!.nodeSize + 2) // 2つ目のトグルの中身の段落の中
    toggleFold(view, pos)
    expect(view.state.selection.$from.parent.type.name).toBe('callout_title')
  })

  it('閉じたトグルの中身にカーソルが入ったら、開く', () => {
    setDoc(src)
    const titleSize = first().firstChild!.nodeSize
    cursorAt(1 + titleSize + 2)
    expect(isClosed(view.state, 0)).toBe(false)
  })

  it('閉じたトグルのタイトルの末尾で Enter: トグルの後ろに新しい行を作る', () => {
    setDoc(src)
    const titleEnd = 1 + first().firstChild!.nodeSize - 1
    cursorAt(titleEnd)
    expect(pressKey('Enter')).toBe(true)
    expect(children(view.state.doc).map((n) => n.type.name)).toEqual(['callout', 'paragraph', 'callout'])
    expect(isClosed(view.state, 0)).toBe(true)
  })

  it('タイトルの行の先頭で Backspace: トグルをやめて、タイトルと中身が普通の段落に戻る', () => {
    const snapshot = setDoc(src)
    cursorAt(2)
    expect(pressKey('Backspace')).toBe(true)
    expect(children(view.state.doc).map((n) => n.type.name)).toEqual(['paragraph', 'paragraph', 'callout'])
    expect(save(snapshot)).toBe('閉じる\n\n中身A\n\n> [!note]+ 開く\n> 中身B\n')
  })
})

describe('Notion の Markdown ショートカット', () => {
  it('行頭で `[] ` を打つと、チェックリストになる', () => {
    const snapshot = setDoc('\n')
    cursorAt(1)
    for (const ch of '[] ') typeText(ch)
    expect(first().type.name).toBe('bullet_list')
    expect(first().child(0).attrs.checked).toBe(false)
    typeText('買い物')
    expect(save(snapshot)).toBe('- [ ] 買い物\n')
  })

  it('行頭で `" ` を打つと、引用になる', () => {
    setDoc('\n')
    cursorAt(1)
    for (const ch of '" ') typeText(ch)
    expect(first().type.name).toBe('blockquote')
  })

  it('`> ` は今までどおり引用になる', () => {
    setDoc('\n')
    cursorAt(1)
    for (const ch of '> ') typeText(ch)
    expect(first().type.name).toBe('blockquote')
  })

  it('`---` で区切り線になり、入力位置は次の行へ移る(最後の行なら次の行を作る)', () => {
    setDoc('\n')
    cursorAt(1)
    for (const ch of '---') typeText(ch)
    expect(first().type.name).toBe('hr')
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.doc.childCount).toBe(2)
  })

  it('文字のある行では `---` は区切り線にならない', () => {
    setDoc('あ\n')
    cursorAt(2)
    for (const ch of '---') typeText(ch)
    expect(first().type.name).toBe('paragraph')
  })
})

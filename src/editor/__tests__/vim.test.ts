// @vitest-environment jsdom
import { Editor, editorViewCtx } from '@milkdown/kit/core'
import { history } from '@milkdown/kit/plugin/history'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { configureMarkdown, loadMarkdown, serializeMarkdown } from '../markdown'
import { buildLines, charClass, graphemeStops } from '../vim/buffer'
import { vimKey, vimPlugin } from '../vim/plugin'
import { setVimEnabled } from '../vim/settings'

let editor: Editor
let view: EditorView
let snapshot: unknown

beforeAll(() => setVimEnabled(true))
afterAll(() => setVimEnabled(false))

beforeEach(async () => {
  editor = await configureMarkdown(Editor.make()).use(history).use(vimPlugin).create()
  view = editor.action((ctx) => ctx.get(editorViewCtx))
})
afterEach(async () => {
  await editor.destroy()
})

function setDoc(markdown: string, at = 0) {
  const loaded = editor.action((ctx) => loadMarkdown(ctx, markdown))
  snapshot = loaded.snapshot
  view.updateState(EditorState.create({ doc: loaded.doc, plugins: view.state.plugins }))
  const lines = buildLines(view.state.doc)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, lines[0].from + at)))
}

const markdown = () => editor.action((ctx) => serializeMarkdown(ctx, view.state.doc, snapshot as never)).trim()
const lines = () => buildLines(view.state.doc).map((l) => l.text)
const mode = () => vimKey.getState(view.state)?.mode
/** カーソルのある行と、行の中の位置(UTF-16) */
function cursor(): [number, number] {
  const ls = buildLines(view.state.doc)
  const head = mode() === 'visual' || mode() === 'vline' ? vimKey.getState(view.state)!.head : view.state.selection.head
  const li = ls.findIndex((l, i) => l.from <= head && (i === ls.length - 1 || ls[i + 1].from > head))
  return [li, head - ls[li].from]
}

function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  view.dom.dispatchEvent(e)
  return e
}

/** Vim のキーを順に押す。<Esc> <CR> <BS> <C-r> などは 1つのキー */
function keys(seq: string) {
  for (const k of seq.match(/<[^>]+>|./gu) ?? []) {
    if (k === '<Esc>') press('Escape')
    else if (k === '<CR>') press('Enter')
    else if (k === '<BS>') press('Backspace')
    else if (k.startsWith('<C-')) press(k[3], { ctrlKey: true })
    else press(k)
  }
}

/** 挿入モードで文字を打つ(日本語入力の確定と同じ経路) */
function type(text: string) {
  const { from, to } = view.state.selection
  const handled = view.someProp('handleTextInput', (f) => f(view, from, to, text, () => view.state.tr.insertText(text, from, to)))
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, to))
}

describe('文字の数え方', () => {
  it('サロゲートペア・絵文字・結合文字は 1文字', () => {
    expect(graphemeStops('𠮷野')).toEqual([0, 2, 3])
    expect(graphemeStops('👨‍👩‍👧a')).toEqual([0, 8, 9])
    expect(graphemeStops('がき')).toEqual([0, 2, 3])
  })
  it('ひらがな・カタカナ・漢字は別の種類', () => {
    expect(new Set(['あ', 'ア', '漢', 'a', '。', '　'].map((c) => charClass(c))).size).toBe(6)
    expect(charClass('ー')).toBe(charClass('ア'))
    expect(charClass('々')).toBe(charClass('漢'))
  })
})

describe('モード', () => {
  it('ノーマルモードでは本文を編集できない状態にし(IME が働かない)、挿入モードで戻す', () => {
    setDoc('あいう\n')
    expect(mode()).toBe('normal')
    expect(view.dom.getAttribute('contenteditable')).toBe('false')
    keys('i')
    expect(mode()).toBe('insert')
    expect(view.dom.getAttribute('contenteditable')).toBe('true')
    keys('<Esc>')
    expect(mode()).toBe('normal')
    expect(view.dom.getAttribute('contenteditable')).toBe('false')
  })

  it('変換中の Esc(isComposing・keyCode 229)では挿入モードのまま。確定してからの Esc で戻る', () => {
    setDoc('メモ\n')
    keys('A')
    press('Escape', { isComposing: true })
    expect(mode()).toBe('insert')
    press('Escape', { keyCode: 229 })
    expect(mode()).toBe('insert')
    type('を書く')
    keys('<Esc>')
    expect(mode()).toBe('normal')
    expect(lines()).toEqual(['メモを書く'])
    // カーソルは最後に打った文字の上(1文字戻る)
    expect(cursor()).toEqual([0, 4])
  })

  it('ノーマルモードの文字のキーは本文に入らない。⌘・Ctrl の組み合わせはアプリに任せる', () => {
    setDoc('abc\n')
    const e = press('q')
    expect(e.defaultPrevented).toBe(true)
    expect(lines()).toEqual(['abc'])
    expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press('s', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('Ctrl+[ でも挿入モードを抜ける', () => {
    setDoc('a\n')
    keys('i')
    press('[', { ctrlKey: true })
    expect(mode()).toBe('normal')
  })
})

describe('移動', () => {
  it('h l は書記素ずつ。行の最後の文字より右へは行かない', () => {
    setDoc('𠮷野家👍\n')
    keys('l')
    expect(cursor()).toEqual([0, 2])
    keys('ll')
    expect(cursor()).toEqual([0, 4])
    keys('l')
    expect(cursor()).toEqual([0, 4])
    keys('h')
    expect(cursor()).toEqual([0, 3])
    keys('$')
    expect(cursor()).toEqual([0, 4])
    keys('0')
    expect(cursor()).toEqual([0, 0])
  })

  it('w b e は日本語の字の種類の切れ目で止まる', () => {
    setDoc('日本語のテキスト、English words\n')
    keys('w')
    expect(cursor()).toEqual([0, 3]) // の
    keys('w')
    expect(cursor()).toEqual([0, 4]) // テ
    keys('w')
    expect(cursor()).toEqual([0, 8]) // 、
    keys('w')
    expect(cursor()).toEqual([0, 9]) // English
    keys('e')
    expect(cursor()).toEqual([0, 15])
    keys('b')
    expect(cursor()).toEqual([0, 9])
    keys('bb')
    expect(cursor()).toEqual([0, 4])
    keys('W')
    expect(cursor()).toEqual([0, 17]) // 空白の後の words
  })

  it('j k は行(ブロック)ごと。文字の位置(書記素の数)を覚えておく', () => {
    setDoc('あいうえお\n\nab\n\nかきくけこ\n', 3)
    keys('j')
    expect(cursor()).toEqual([1, 1])
    keys('j')
    expect(cursor()).toEqual([2, 3])
    keys('gg')
    expect(cursor()).toEqual([0, 0])
    keys('G')
    expect(cursor()).toEqual([2, 0])
  })

  it('f t は全角の文字にも当たる(f. で「。」、f( で「（」)', () => {
    setDoc('今日は晴れ。明日（雨）\n')
    keys('f.')
    expect(cursor()).toEqual([0, 5])
    keys('f(')
    expect(cursor()).toEqual([0, 8])
    keys('0t.')
    expect(cursor()).toEqual([0, 4])
    keys(';')
    expect(cursor()).toEqual([0, 4])
  })

  it('数を付けると、その回数だけ動く', () => {
    setDoc('one two three four\n')
    keys('3w')
    expect(cursor()).toEqual([0, 14])
  })
})

describe('編集', () => {
  it('x はサロゲートペア・絵文字を丸ごと消す。u で戻し、Ctrl+R でやり直す', () => {
    setDoc('𠮷👨‍👩‍👧野\n')
    keys('x')
    expect(lines()).toEqual(['👨‍👩‍👧野'])
    keys('x')
    expect(lines()).toEqual(['野'])
    keys('u')
    expect(lines()).toEqual(['👨‍👩‍👧野'])
    keys('u')
    expect(lines()).toEqual(['𠮷👨‍👩‍👧野'])
    keys('<C-r>')
    expect(lines()).toEqual(['👨‍👩‍👧野'])
  })

  it('dw cw diw', () => {
    setDoc('hello world foo\n')
    keys('dw')
    expect(lines()).toEqual(['world foo'])
    keys('cwbar')
    expect(mode()).toBe('insert')
    type('日本')
    keys('<Esc>')
    expect(lines()).toEqual(['日本 foo'])
    setDoc('日本語のテキスト\n', 5)
    keys('diw')
    expect(lines()).toEqual(['日本語の'])
  })

  it('ci( は全角の括弧にも、di[ は「」にも効く', () => {
    setDoc('予定（会議）と「メモ」\n', 4)
    keys('ci(')
    type('打ち合わせ')
    keys('<Esc>')
    expect(lines()).toEqual(['予定（打ち合わせ）と「メモ」'])
    keys('$hdi[')
    expect(lines()).toEqual(['予定（打ち合わせ）と「」'])
    keys('0f(da(')
    expect(lines()).toEqual(['予定と「」'])
  })

  it('dd yy p P は行(ブロック)ごと。書式を保つ', () => {
    setDoc('一行目\n\n**二行目**\n\n三行目\n')
    keys('jdd')
    expect(lines()).toEqual(['一行目', '三行目'])
    keys('p')
    expect(lines()).toEqual(['一行目', '三行目', '二行目'])
    expect(markdown()).toContain('**二行目**')
    keys('ggyyP')
    expect(lines()).toEqual(['一行目', '一行目', '三行目', '二行目'])
    keys('ggdG')
    expect(lines()).toEqual([''])
  })

  it('リストの項目で dd すると項目ごと消え、o は次の項目を作る', () => {
    setDoc('- りんご\n- みかん\n- ぶどう\n')
    keys('jdd')
    expect(markdown()).toBe('- りんご\n- ぶどう')
    keys('o')
    type('もも')
    keys('<Esc>')
    expect(markdown()).toBe('- りんご\n- ぶどう\n- もも')
    keys('ggO')
    type('なし')
    keys('<Esc>')
    expect(lines()).toEqual(['なし', 'りんご', 'ぶどう', 'もも'])
  })

  it('コードブロックの中では、改行で分けた 1行ずつ', () => {
    setDoc('```\na = 1\nb = 2\nc = 3\n```\n')
    keys('jdd')
    expect(lines()).toEqual(['a = 1', 'c = 3'])
    keys('ggyyp')
    expect(lines()).toEqual(['a = 1', 'a = 1', 'c = 3'])
    keys('Gdd')
    expect(lines()).toEqual(['a = 1', 'a = 1'])
    expect(cursor()[0]).toBe(1)
  })

  it('「.」で直前の変更を繰り返す(打った日本語も)', () => {
    setDoc('a b c\n')
    keys('x')
    keys('.')
    expect(lines()).toEqual(['b c'])
    keys('A')
    type('です')
    keys('<Esc>')
    keys('j.')
    expect(lines()).toEqual(['b cですです'])
    setDoc('one two three\n')
    keys('cw')
    type('壱')
    keys('<Esc>')
    keys('w.')
    expect(lines()).toEqual(['壱 壱 three'])
  })

  it('J は日本語どうしなら空白を入れずにつなぐ', () => {
    setDoc('今日は\n\n晴れ\n\nhello\n\nworld\n')
    keys('J')
    expect(lines()).toEqual(['今日は晴れ', 'hello', 'world'])
    keys('jJ')
    expect(lines()).toEqual(['今日は晴れ', 'hello world'])
  })

  it('r ~ は書記素ずつ', () => {
    setDoc('abc𠮷\n')
    keys('3~')
    expect(lines()).toEqual(['ABC𠮷'])
    keys('$rx')
    expect(lines()).toEqual(['ABCx'])
  })

  it('>> でリストの項目を 1段深くし、<< で戻す', () => {
    setDoc('- 親\n- 子\n')
    keys('j>>')
    expect(markdown()).toBe('- 親\n  - 子')
    keys('<<')
    expect(markdown()).toBe('- 親\n- 子')
  })
})

describe('ビジュアルモード', () => {
  it('v で選んで d・y、V で行ごと', () => {
    setDoc('あいうえお\n\nかきくけこ\n\nさしすせそ\n', 1)
    keys('vlld')
    expect(lines()).toEqual(['あお', 'かきくけこ', 'さしすせそ'])
    expect(mode()).toBe('normal')
    keys('jVjd')
    expect(lines()).toEqual(['あお'])
    keys('viwy')
    keys('P')
    expect(lines()).toEqual(['あおあお'])
  })

  it('マウスで選ぶとビジュアルモードになり、Esc で戻る', () => {
    setDoc('abcdef\n')
    const from = buildLines(view.state.doc)[0].from
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1, from + 4)))
    expect(mode()).toBe('visual')
    keys('d')
    expect(lines()).toEqual(['aef'])
    expect(mode()).toBe('normal')
  })
})

describe('挿入モードとオン・オフ', () => {
  it('挿入モードでは、どのキーも横取りしない(h j k も普通に打てる)', () => {
    setDoc('a\n')
    keys('A')
    for (const k of ['h', 'j', 'k', 'x', 'd', ':']) expect(press(k).defaultPrevented).toBe(false)
  })

  it('オフにすると本文は編集できる状態に戻り、キーを横取りしない。オンに戻すと NORMAL から', () => {
    setDoc('abc\n')
    setVimEnabled(false)
    expect(view.dom.getAttribute('contenteditable')).toBe('true')
    expect(press('x').defaultPrevented).toBe(false)
    expect(lines()).toEqual(['abc'])
    expect(view.dom.classList.contains('jot-vim')).toBe(false)
    setVimEnabled(true)
    expect(mode()).toBe('normal')
    expect(view.dom.getAttribute('contenteditable')).toBe('false')
  })

  it('打ちかけのコマンドは Esc で捨てる', () => {
    setDoc('abc def\n')
    keys('d<Esc>w')
    expect(lines()).toEqual(['abc def'])
    expect(cursor()).toEqual([0, 4])
  })

  it('o で打ったあと u 1回で、打つ前に戻る', () => {
    setDoc('一\n')
    keys('o')
    type('二')
    keys('<Esc>u')
    expect(lines()).toEqual(['一'])
  })
})

describe('編集(続き)', () => {
  it('行の最後の単語の dw は、次の行とつなげない', () => {
    setDoc('foo bar\n\nbaz\n', 4)
    keys('dw')
    expect(lines()).toEqual(['foo ', 'baz'])
  })

  it('空の行で x しても何も起きない', () => {
    setDoc('a\n\n<br />\n\nb\n')
    keys('jx')
    expect(lines()).toEqual(['a', '', 'b'])
  })

  it('D C は行の終わりまで', () => {
    setDoc('今日は晴れです\n', 3)
    keys('D')
    expect(lines()).toEqual(['今日は'])
    keys('0lC')
    type('曜日')
    keys('<Esc>')
    expect(lines()).toEqual(['今曜日'])
  })

  it('cc はリストの印を残して中身だけ書き換える', () => {
    setDoc('- 古い項目\n- 次\n')
    keys('cc')
    type('新しい項目')
    keys('<Esc>')
    expect(markdown()).toBe('- 新しい項目\n- 次')
  })

  it('ci" ca" ', () => {
    setDoc('say "こんにちは" ok\n', 6)
    keys('ci"')
    type('やあ')
    keys('<Esc>')
    expect(lines()).toEqual(['say "やあ" ok'])
    keys('da"')
    expect(lines()).toEqual(['say  ok'])
  })

  it('yiw と p は書式(太字)ごと貼る', () => {
    setDoc('**太字** と普通\n')
    keys('yiw$p')
    expect(markdown()).toBe('**太字** と普通**太字**')
  })

  it('viwp で選んだ単語を、覚えた単語で置き換える(行の途中でも、行の終わりでも)', () => {
    setDoc('apple banana\n')
    keys('yiwwviwp')
    expect(lines()).toEqual(['apple apple'])
    setDoc('one two three\n')
    keys('yiwwviwp')
    expect(lines()).toEqual(['one one three'])
    // p は消した語で覚えた内容を上書きする(two を覚えている)
    keys('$viwp')
    expect(lines()).toEqual(['one one two'])
  })

  it('Vp で行を、覚えた行で置き換える(最後の行でも)', () => {
    setDoc('一\n\n二\n\n三\n')
    keys('yyGVp')
    expect(lines()).toEqual(['一', '二', '一'])
    keys('ggjVp')
    expect(lines()).toEqual(['一', '三', '一'])
  })

  it('gu gU は英字だけを変え、日本語はそのまま', () => {
    setDoc('Hello 世界 World\n')
    keys('gUU')
    expect(lines()).toEqual(['HELLO 世界 WORLD'])
    keys('guiw')
    expect(lines()).toEqual(['hello 世界 WORLD'])
  })

  it('数を付けた「.」', () => {
    setDoc('abcdef\n')
    keys('x3.')
    expect(lines()).toEqual(['ef'])
  })

  it('段落の中の改行(Shift+Enter)で分けた行も 1行ずつ', () => {
    setDoc('一行目  \n二行目\n')
    expect(lines()).toEqual(['一行目', '二行目'])
    keys('jdd')
    expect(lines()).toEqual(['一行目'])
  })

  it('表のマスの中で dd しても表は壊れず、文字だけ消える', () => {
    setDoc('| a | b |\n| - | - |\n| c | d |\n')
    const before = lines().length
    keys('dd')
    expect(lines().length).toBe(before)
    expect(lines()[0]).toBe('')
    expect(view.state.doc.firstChild?.type.name).toBe('table')
  })

  it('区切り線をはさんだ J は、区切り線を消さない', () => {
    setDoc('上\n\n---\n\n下\n')
    keys('J')
    expect(view.state.doc.childCount).toBe(3)
  })
})

describe('移動(続き)', () => {
  it('% で対の括弧(全角も)へ', () => {
    setDoc('f(a, （b）)\n')
    keys('%')
    expect(cursor()).toEqual([0, 8])
    keys('%')
    expect(cursor()).toEqual([0, 1])
    keys('f（%')
    expect(cursor()).toEqual([0, 7])
    keys('%')
    expect(cursor()).toEqual([0, 5])
  })

  it('{ } は空の行へ', () => {
    setDoc('a\n\nb\n\n<br />\n\nc\n')
    const ls = lines()
    const empty = ls.indexOf('')
    expect(empty).toBeGreaterThan(0)
    keys('}')
    expect(cursor()[0]).toBe(empty)
    keys('{')
    expect(cursor()[0]).toBe(0)
  })

  it('* でカーソルの単語を探し、n N で行き来する', () => {
    setDoc('猫 と 犬\n\n犬 と 猫\n', 4)
    keys('*')
    expect(cursor()).toEqual([1, 0])
    keys('n')
    expect(cursor()).toEqual([0, 4])
    keys('N')
    expect(cursor()).toEqual([1, 0])
  })

  it('クリックで行の終わりに置いたカーソルは、最後の文字に寄せる', () => {
    setDoc('あいう\n')
    const l = buildLines(view.state.doc)[0]
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, l.to)))
    expect(cursor()).toEqual([0, 2])
  })

  it('ビジュアルの o で反対の端へ、V で行の選択に変える', () => {
    setDoc('abcdef\n\nxyz\n', 1)
    keys('vllo')
    expect(cursor()).toEqual([0, 1])
    keys('Vjy')
    expect(mode()).toBe('normal')
    keys('Gp')
    expect(lines()).toEqual(['abcdef', 'xyz', 'abcdef', 'xyz'])
    keys('ggP')
    expect(lines()).toEqual(['abcdef', 'xyz', 'abcdef', 'xyz', 'abcdef', 'xyz'])
  })
})

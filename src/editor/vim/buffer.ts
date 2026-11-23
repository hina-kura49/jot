import type { Node as PMNode } from '@milkdown/kit/prose/model'

// Vim のモードで使う「行」の見方。
// 段落・見出しなどの文字のブロック 1つを 1行とみなす。コードブロックと、段落の中の改行(Shift+Enter)は、その改行で行を分ける。
// 行の text の 1文字(UTF-16 の 1単位)は、文書の位置 1つに対応する(ProseMirror の位置も UTF-16 の単位で数えるため)。
// 画像などの行内の部品は 1つで 1位置なので、OBJ(U+FFFC)の 1文字として入れる。

export const OBJ = '￼'

export type Line = {
  /** 行の最初の文字の位置 */
  from: number
  /** 行の最後の文字の次の位置(改行の手前) */
  to: number
  text: string
  /** この行を含む文字のブロックの、ブロックの手前の位置 */
  blockPos: number
  block: PMNode
  /** ブロックが改行で分かれていない(行 = ブロック全体) */
  whole: boolean
  /** コードブロックの中の行 */
  code: boolean
}

export function buildLines(doc: PMNode): Line[] {
  const lines: Line[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const start = pos + 1
    const text = node.textBetween(0, node.content.size, undefined, (leaf) => (leaf.type.name.includes('break') ? '\n' : OBJ))
    const parts = text.split('\n')
    let offset = 0
    for (const part of parts) {
      lines.push({
        from: start + offset,
        to: start + offset + part.length,
        text: part,
        blockPos: pos,
        block: node,
        whole: parts.length === 1,
        code: !!node.type.spec.code,
      })
      offset += part.length + 1
    }
    return false
  })
  return lines
}

/** pos を含む行の番号(行と行の間なら、後ろの行) */
export function lineIndexAt(lines: Line[], pos: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].from <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ---- 書記素(見た目の 1文字。絵文字や 𠮷 のようなサロゲートペア、結合文字を分けない) ----

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null

/** text の書記素の始まりの位置(0 と、最後の text.length を含む) */
export function graphemeStops(text: string): number[] {
  const stops: number[] = []
  if (segmenter) {
    for (const s of segmenter.segment(text)) stops.push(s.index)
  } else {
    for (let i = 0; i < text.length; ) {
      stops.push(i)
      const c = text.codePointAt(i) ?? 0
      i += c > 0xffff ? 2 : 1
    }
  }
  stops.push(text.length)
  return stops
}

/** offset を含む書記素の始まり */
export function graphemeStart(text: string, offset: number): number {
  const stops = graphemeStops(text)
  let s = 0
  for (const stop of stops) {
    if (stop > offset) break
    s = stop
  }
  return s
}

export function nextGrapheme(text: string, offset: number): number {
  for (const stop of graphemeStops(text)) if (stop > offset) return stop
  return text.length
}

export function prevGrapheme(text: string, offset: number): number {
  let prev = 0
  for (const stop of graphemeStops(text)) {
    if (stop >= offset) break
    prev = stop
  }
  return prev
}

/** 行の最後の書記素の始まり(空の行なら 0)。ノーマルモードのカーソルはここより右へ行かない */
export const lastGraphemeStart = (text: string) => (text.length === 0 ? 0 : prevGrapheme(text, text.length))

/** offset が何文字目(書記素で数えて)か */
export const columnOf = (text: string, offset: number) => graphemeStops(text).filter((s) => s < offset).length

/** col 文字目の始まり。足りなければ最後の文字 */
export function offsetOfColumn(text: string, col: number, allowEnd = false): number {
  const stops = graphemeStops(text)
  const max = allowEnd ? stops.length - 1 : Math.max(0, stops.length - 2)
  return stops[Math.min(col, max)] ?? 0
}

// ---- 文字の種類(単語の区切り) ----
// Vim と同じく、空白・記号・英数字に加えて、ひらがな・カタカナ・漢字・全角の英数字・全角の記号を別の種類として扱う。
// 「日本語のテキスト」なら「日本語」「の」「テキスト」で区切れる。

export const CharClass = {
  Blank: 0,
  Punct: 1,
  Word: 2,
  Hiragana: 3,
  Katakana: 4,
  Kanji: 5,
  WideWord: 6,
  WidePunct: 7,
  Emoji: 8,
  Object: 9,
} as const
export type CharClass = (typeof CharClass)[keyof typeof CharClass]

export function charClass(ch: string, bigWord = false): CharClass {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0x20 || c === 0x09 || c === 0xa0 || c === 0x3000 || ch === '') return CharClass.Blank
  if (bigWord) return CharClass.Word
  if (ch === OBJ) return CharClass.Object
  if (c < 0x80) return /[A-Za-z0-9_]/.test(ch) ? CharClass.Word : CharClass.Punct
  if (c >= 0x3041 && c <= 0x309f) return CharClass.Hiragana
  // ー(長音)はカタカナの中で使うので、カタカナにする
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9f) || (c >= 0x31f0 && c <= 0x31ff)) return CharClass.Katakana
  if (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x20000 && c <= 0x3ffff) ||
    c === 0x3005 || // 々
    c === 0x3006 || // 〆
    c === 0x3007 // 〇
  )
    return CharClass.Kanji
  if ((c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a)) return CharClass.WideWord
  if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x2000 && c <= 0x206f)) return CharClass.WidePunct
  if (c >= 0x1f000) return CharClass.Emoji
  // ラテン文字(アクセント付き)・ギリシャ文字・キリル文字などは英字と同じ
  return /\p{L}|\p{N}/u.test(ch) ? CharClass.Word : CharClass.Punct
}

/** 全角の文字(日本語など)か。行をつなげる(J)とき、空白を入れるかどうかに使う */
export const isWide = (ch: string) => {
  const k = charClass(ch)
  return k >= CharClass.Hiragana && k <= CharClass.WidePunct
}

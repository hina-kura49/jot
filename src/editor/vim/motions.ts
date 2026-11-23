import {
  CharClass,
  charClass,
  graphemeStart,
  lastGraphemeStart,
  nextGrapheme,
  prevGrapheme,
  type Line,
} from './buffer'

// 行の見方(buffer.ts)の上で、カーソルの動き(モーション)と範囲(テキストオブジェクト)を求める。文書には触らない。

/** 行の番号と、行の中の位置(UTF-16 の単位。書記素の始まりか、行の終わり) */
export type Cur = { li: number; off: number }

// ---- 1文字ずつ(行の終わりの改行も 1つの「文字」として)進む・戻る ----

const NL = '\n'

export function next(lines: Line[], c: Cur): Cur | null {
  const { text } = lines[c.li]
  if (c.off < text.length) return { li: c.li, off: nextGrapheme(text, c.off) }
  return c.li + 1 < lines.length ? { li: c.li + 1, off: 0 } : null
}

export function prev(lines: Line[], c: Cur): Cur | null {
  if (c.off > 0) return { li: c.li, off: prevGrapheme(lines[c.li].text, c.off) }
  return c.li > 0 ? { li: c.li - 1, off: lines[c.li - 1].text.length } : null
}

export function charAt(lines: Line[], c: Cur): string {
  const { text } = lines[c.li]
  return c.off >= text.length ? NL : text.slice(c.off, nextGrapheme(text, c.off))
}

const cls = (lines: Line[], c: Cur, big: boolean) => {
  const ch = charAt(lines, c)
  return ch === NL ? CharClass.Blank : charClass(ch, big)
}
const emptyLine = (lines: Line[], c: Cur) => lines[c.li].text.length === 0

const endOfDoc = (lines: Line[]): Cur => ({ li: lines.length - 1, off: lines[lines.length - 1].text.length })

// ---- 単語 ----

/** c が単語の最後の文字か(次の文字が違う種類・行の終わり) */
export function isWordEnd(lines: Line[], c: Cur, big: boolean): boolean {
  const n = next(lines, c)
  return !n || n.li !== c.li || cls(lines, n, big) !== cls(lines, c, big)
}

/** w / W。行をまたぐ。空の行でも止まる。文書の終わりなら、最後の行の終わり */
export function wordForward(lines: Line[], c: Cur, big: boolean): Cur {
  let p = c
  const k = cls(lines, c, big)
  if (k !== CharClass.Blank) {
    for (;;) {
      const n = next(lines, p)
      if (!n) return endOfDoc(lines)
      p = n
      if (cls(lines, p, big) !== k) break
    }
  } else {
    const n = next(lines, p)
    if (!n) return endOfDoc(lines)
    p = n
  }
  while (cls(lines, p, big) === CharClass.Blank) {
    if (emptyLine(lines, p)) break
    const n = next(lines, p)
    if (!n) return endOfDoc(lines)
    p = n
  }
  return p
}

/** e / E。単語の最後の文字 */
export function wordEnd(lines: Line[], c: Cur, big: boolean): Cur {
  let p = next(lines, c)
  if (!p) return c
  while (cls(lines, p, big) === CharClass.Blank) {
    const n = next(lines, p)
    if (!n) return p
    p = n
  }
  const k = cls(lines, p, big)
  for (;;) {
    const n = next(lines, p)
    if (!n || cls(lines, n, big) !== k) return p
    p = n
  }
}

/** b / B。単語の最初の文字 */
export function wordBackward(lines: Line[], c: Cur, big: boolean): Cur {
  let p = prev(lines, c)
  if (!p) return c
  while (cls(lines, p, big) === CharClass.Blank) {
    if (emptyLine(lines, p)) return p
    const n = prev(lines, p)
    if (!n) return p
    p = n
  }
  const k = cls(lines, p, big)
  for (;;) {
    const n = prev(lines, p)
    if (!n || cls(lines, n, big) !== k) return p
    p = n
  }
}

/** ge / gE。前の単語の最後の文字 */
export function wordEndBackward(lines: Line[], c: Cur, big: boolean): Cur {
  let p = c
  const k = cls(lines, c, big)
  if (k !== CharClass.Blank) {
    for (;;) {
      const n = prev(lines, p)
      if (!n) return { li: 0, off: 0 }
      p = n
      if (cls(lines, p, big) !== k) break
    }
  } else {
    const n = prev(lines, p)
    if (!n) return c
    p = n
  }
  while (cls(lines, p, big) === CharClass.Blank) {
    if (emptyLine(lines, p)) return p
    const n = prev(lines, p)
    if (!n) return p
    p = n
  }
  return p
}

// ---- 行の中 ----

export const firstNonBlank = (text: string) => {
  const m = /^[ \t　 ]*/.exec(text)
  const off = m ? m[0].length : 0
  return off >= text.length ? lastGraphemeStart(text) : off
}

export const lastNonBlank = (text: string) => {
  const trimmed = text.replace(/[ \t　 ]+$/, '')
  return trimmed.length === 0 ? 0 : graphemeStart(text, trimmed.length - 1)
}

/**
 * f / t で探す文字と同じか。日本語の文の中でも使えるように、全角の英数字・記号は半角と同じに見る(NFKC)。
 * さらに「.」は「。」、「,」は「、」、「[」「]」は「」『』【】にも当たる(ノーマルモードでは日本語を打てないため)
 */
const FIND_ALIASES: Record<string, string[]> = {
  '.': ['。', '．'],
  ',': ['、', '，'],
  '[': ['「', '『', '【', '〔'],
  ']': ['」', '』', '】', '〕'],
  '<': ['〈', '《'],
  '>': ['〉', '》'],
  '-': ['ー', '－'],
  '~': ['〜', '～'],
}
export function sameFindChar(target: string, ch: string): boolean {
  if (ch === target) return true
  if (ch.normalize('NFKC') === target.normalize('NFKC')) return true
  return FIND_ALIASES[target]?.includes(ch) ?? false
}

export type FindKind = 'f' | 'F' | 't' | 'T'

/** f F t T。見つからなければ null。count 個目を探す */
export function findInLine(text: string, off: number, kind: FindKind, target: string, count: number, repeat = false): number | null {
  const forward = kind === 'f' || kind === 't'
  const till = kind === 't' || kind === 'T'
  let p = off
  let found: number | null = null
  // ; で t を繰り返すとき、すぐ隣の文字で止まったままにならないように 1つ先から探す
  if (repeat && till) p = forward ? nextGrapheme(text, p) : prevGrapheme(text, p)
  for (let n = 0; n < count; n++) {
    found = null
    let q = p
    for (;;) {
      if (forward) {
        q = nextGrapheme(text, q)
        if (q >= text.length) break
      } else {
        if (q <= 0) break
        q = prevGrapheme(text, q)
      }
      if (sameFindChar(target, text.slice(q, nextGrapheme(text, q)))) {
        found = q
        break
      }
    }
    if (found === null) return null
    p = found
  }
  if (found === null) return null
  if (!till) return found
  return forward ? prevGrapheme(text, found) : nextGrapheme(text, found)
}

// ---- 括弧 ----

/** 対になる括弧。日本語の括弧も入れる */
export const BRACKET_PAIRS: [string, string][] = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['［', '］'],
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['〔', '〕'],
  ['{', '}'],
  ['｛', '｝'],
  ['<', '>'],
  ['〈', '〉'],
  ['《', '》'],
]

/** テキストオブジェクトの文字(i( の「(」など) → 当てる括弧の組 */
export function bracketPairsFor(key: string): [string, string][] | null {
  if ('()b'.includes(key)) return [BRACKET_PAIRS[0], BRACKET_PAIRS[1]]
  if ('[]'.includes(key)) return BRACKET_PAIRS.slice(2, 8)
  if ('{}B'.includes(key)) return [BRACKET_PAIRS[8], BRACKET_PAIRS[9]]
  if ('<>'.includes(key)) return BRACKET_PAIRS.slice(10)
  return null
}

/** ひとつのブロックの行をつないだ文字と、行ごとの始まり(つないだ文字の中の位置) */
type Flat = { text: string; starts: number[]; first: number }

function flatBlock(lines: Line[], li: number): Flat {
  const blockPos = lines[li].blockPos
  let first = li
  while (first > 0 && lines[first - 1].blockPos === blockPos) first--
  let last = li
  while (last + 1 < lines.length && lines[last + 1].blockPos === blockPos) last++
  const starts: number[] = []
  let text = ''
  for (let i = first; i <= last; i++) {
    starts.push(text.length)
    text += lines[i].text + (i < last ? NL : '')
  }
  return { text, starts, first }
}

const flatIndex = (f: Flat, c: Cur) => f.starts[c.li - f.first] + c.off
function flatCur(f: Flat, i: number): Cur {
  let k = 0
  while (k + 1 < f.starts.length && f.starts[k + 1] <= i) k++
  return { li: f.first + k, off: i - f.starts[k] }
}

/** i を囲む、いちばん内側の括弧(open と close の位置)。i が括弧の上でも数える */
function enclosing(text: string, i: number, pairs: [string, string][]): [number, number] | null {
  let best: [number, number] | null = null
  for (const [open, close] of pairs) {
    // 左へ、閉じていない open を探す
    let depth = 0
    let o = -1
    for (let j = text[i] === close ? i - 1 : i; j >= 0; j--) {
      if (text[j] === close && j !== i) depth++
      else if (text[j] === open) {
        if (depth === 0) {
          o = j
          break
        }
        depth--
      }
    }
    if (o < 0) continue
    depth = 0
    let c = -1
    for (let j = o + 1; j < text.length; j++) {
      if (text[j] === open) depth++
      else if (text[j] === close) {
        if (depth === 0) {
          c = j
          break
        }
        depth--
      }
    }
    if (c < 0 || c < i) continue
    if (!best || o > best[0]) best = [o, c]
  }
  return best
}

/** % 。カーソルから右の最初の括弧と対になる括弧(ブロックの中だけ) */
export function matchBracket(lines: Line[], c: Cur): Cur | null {
  const f = flatBlock(lines, c.li)
  const start = flatIndex(f, c)
  const lineEnd = f.starts[c.li - f.first] + lines[c.li].text.length
  for (let i = start; i < lineEnd; i++) {
    for (const [open, close] of BRACKET_PAIRS) {
      if (f.text[i] === open) {
        const m = enclosing(f.text, i, [[open, close]])
        return m ? flatCur(f, m[1]) : null
      }
      if (f.text[i] === close) {
        const m = enclosing(f.text, i, [[open, close]])
        return m ? flatCur(f, m[0]) : null
      }
    }
  }
  return null
}

// ---- テキストオブジェクト ----

/** 文字の範囲(start は含む、end は含まない) */
export type CharRange = { start: Cur; end: Cur }
/** 行の範囲(両端を含む) */
export type LineRange = { first: number; last: number }

export function wordObject(lines: Line[], c: Cur, around: boolean, big: boolean): CharRange | null {
  const { text } = lines[c.li]
  if (text.length === 0) return null
  const at = Math.min(c.off, lastGraphemeStart(text))
  const k = charClass(text.slice(at, nextGrapheme(text, at)), big)
  const same = (o: number) => o >= 0 && o < text.length && charClass(text.slice(o, nextGrapheme(text, o)), big) === k
  let s = at
  while (s > 0 && same(prevGrapheme(text, s))) s = prevGrapheme(text, s)
  let e = nextGrapheme(text, at)
  while (e < text.length && same(e)) e = nextGrapheme(text, e)
  if (around) {
    const blank = (o: number) => o < text.length && charClass(text.slice(o, nextGrapheme(text, o))) === CharClass.Blank
    if (k === CharClass.Blank) {
      // 空白の上なら、空白と、その後の単語
      if (e < text.length) {
        const k2 = charClass(text.slice(e, nextGrapheme(text, e)), big)
        while (e < text.length && charClass(text.slice(e, nextGrapheme(text, e)), big) === k2) e = nextGrapheme(text, e)
      }
    } else if (blank(e)) {
      while (blank(e)) e = nextGrapheme(text, e)
    } else {
      while (s > 0 && blank(prevGrapheme(text, s))) s = prevGrapheme(text, s)
    }
  }
  return { start: { li: c.li, off: s }, end: { li: c.li, off: e } }
}

const QUOTE_PAIRS: Record<string, [string, string][]> = {
  '"': [
    ['"', '"'],
    ['“', '”'],
  ],
  "'": [
    ["'", "'"],
    ['‘', '’'],
  ],
  '`': [['`', '`']],
}

export function quoteObject(lines: Line[], c: Cur, quote: string, around: boolean): CharRange | null {
  const pairs = QUOTE_PAIRS[quote]
  if (!pairs) return null
  const { text } = lines[c.li]
  let best: [number, number] | null = null
  for (const [open, close] of pairs) {
    if (open === close) {
      // 行の先頭から 2つずつ組にする(Vim と同じ)
      const idx: number[] = []
      for (let i = 0; i < text.length; i++) if (text[i] === open && text[i - 1] !== '\\') idx.push(i)
      for (let k = 0; k + 1 < idx.length; k += 2) {
        const [o, e] = [idx[k], idx[k + 1]]
        if ((c.off >= o && c.off <= e) || (o > c.off && !best)) {
          best = [o, e]
          if (c.off >= o) break
        }
      }
    } else {
      const m = enclosing(text, c.off, [[open, close]])
      if (m) best = m
    }
  }
  if (!best) return null
  const [o, e] = best
  return around
    ? { start: { li: c.li, off: o }, end: { li: c.li, off: e + 1 } }
    : { start: { li: c.li, off: o + 1 }, end: { li: c.li, off: e } }
}

export function bracketObject(lines: Line[], c: Cur, key: string, around: boolean): CharRange | null {
  const pairs = bracketPairsFor(key)
  if (!pairs) return null
  const f = flatBlock(lines, c.li)
  const m = enclosing(f.text, flatIndex(f, c), pairs)
  if (!m) return null
  const [o, e] = m
  return around ? { start: flatCur(f, o), end: flatCur(f, e + 1) } : { start: flatCur(f, o + 1), end: flatCur(f, e) }
}

const blankLine = (l: Line) => /^[ \t　 ]*$/.test(l.text)

/** ip / ap。空の行で区切られた行のまとまり */
export function paragraphObject(lines: Line[], li: number, around: boolean): LineRange {
  const kind = blankLine(lines[li])
  let first = li
  while (first > 0 && blankLine(lines[first - 1]) === kind) first--
  let last = li
  while (last + 1 < lines.length && blankLine(lines[last + 1]) === kind) last++
  if (around && !kind) {
    if (last + 1 < lines.length) while (last + 1 < lines.length && blankLine(lines[last + 1])) last++
    else while (first > 0 && blankLine(lines[first - 1])) first--
  }
  return { first, last }
}

/** { / } 。前・次の空の行 */
export function paragraphMove(lines: Line[], li: number, dir: 1 | -1, count: number): number {
  let i = li
  for (let n = 0; n < count; n++) {
    // いまの空の行の並びを抜けてから、次の空の行を探す
    while (i + dir >= 0 && i + dir < lines.length && blankLine(lines[i + dir])) i += dir
    i += dir
    while (i >= 0 && i < lines.length && !blankLine(lines[i])) i += dir
    if (i < 0) return 0
    if (i >= lines.length) return lines.length - 1
  }
  return i
}

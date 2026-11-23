import { Fragment, Slice, type Node as PMNode } from '@milkdown/kit/prose/model'
import { closeHistory, redo, undo } from '@milkdown/kit/prose/history'
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { openFind } from '@/app/find-store'
import { findMatches, findPluginKey } from '../find'
import {
  buildLines,
  columnOf,
  graphemeStart,
  isWide,
  lastGraphemeStart,
  lineIndexAt,
  nextGrapheme,
  OBJ,
  offsetOfColumn,
  prevGrapheme,
  type Line,
} from './buffer'
import {
  bracketObject,
  charAt,
  isWordEnd,
  findInLine,
  firstNonBlank,
  lastNonBlank,
  matchBracket,
  paragraphMove,
  paragraphObject,
  quoteObject,
  wordBackward,
  wordEnd,
  wordEndBackward,
  wordForward,
  wordObject,
  type CharRange,
  type Cur,
  type FindKind,
  type LineRange,
} from './motions'
import { onVimSetting, vimEnabled } from './settings'

// 本文の Vim のキー操作(IdeaVim と同じくらい)。
//
// 日本語入力との付き合い方:
// - ノーマル・ビジュアルモードの間は、本文の contenteditable を false にする。編集できない所には日本語入力(IME)が働かないので、
//   Mozc などがオンのままでも h j k l がそのまま届き、変換の途中の文字が本文に入ることもない。
//   ProseMirror の editable はずっと true のままにする(貼り付け・ドロップ・ほかの部品の動きを変えないため)。
// - 挿入モードは普通の入力と同じ。IME の変換中のキー(isComposing・keyCode 229)には一切触らない。
//   変換中の Esc は IME が変換の取り消しに使うので、もう一度 Esc を押したときにノーマルモードへ戻る。
// - カーソルの移動・削除は書記素(見た目の 1文字)単位。絵文字や「𠮷」のようなサロゲートペアを途中で切らない。
// - 単語(w b e、iw)は、ひらがな・カタカナ・漢字・英数字・記号の切れ目で区切る(Vim と同じ)。

export type Mode = 'normal' | 'insert' | 'visual' | 'vline'

type VimState = {
  mode: Mode
  /** ビジュアルモードの起点と、カーソル(どちらも文字の始まりの位置) */
  anchor: number
  head: number
  /** 挿入モードに入った位置(「.」で繰り返すとき、打った文字を取り出すため) */
  insertStart: number | null
}

type Meta = Partial<VimState> & { vim?: true }

export const vimKey = new PluginKey<VimState>('jot-vim')

const vimState = (state: EditorState): VimState => vimKey.getState(state) ?? { mode: 'insert', anchor: 0, head: 0, insertStart: null }

/** Vim のキー操作が働いている(オンで、挿入モードでない) */
const commanding = (state: EditorState) => vimEnabled() && vimState(state).mode !== 'insert'

export const vimMode = (state: EditorState): Mode | null => (vimEnabled() ? vimState(state).mode : null)

// ---- 行の見方(文書ごとに 1回だけ作る) ----

const linesCache = new WeakMap<PMNode, Line[]>()
function linesOf(doc: PMNode): Line[] {
  let lines = linesCache.get(doc)
  if (!lines) {
    lines = buildLines(doc)
    linesCache.set(doc, lines)
  }
  return lines
}

function curOf(lines: Line[], pos: number): Cur {
  const li = lineIndexAt(lines, pos)
  const l = lines[li]
  return { li, off: Math.max(0, Math.min(pos - l.from, l.text.length)) }
}
const posOf = (lines: Line[], c: Cur) => lines[c.li].from + c.off

/** ノーマルモードのカーソルを置ける位置(行の最後の文字より右へは行かない) */
function normalOff(text: string, off: number): number {
  if (text.length === 0) return 0
  return Math.min(graphemeStart(text, Math.min(off, text.length - 1)), lastGraphemeStart(text))
}
function clampNormal(lines: Line[], pos: number): number {
  const c = curOf(lines, pos)
  return lines[c.li].from + normalOff(lines[c.li].text, c.off)
}

// ---- キー ----

const SPECIAL: Record<string, string> = {
  Escape: '<Esc>',
  Enter: '<CR>',
  Backspace: '<BS>',
  Delete: 'x',
  ArrowLeft: 'h',
  ArrowRight: 'l',
  ArrowUp: 'k',
  ArrowDown: 'j',
  Home: '0',
  End: '$',
  PageUp: '<C-u>',
  PageDown: '<C-d>',
}

/** キーの押下を Vim のキーの名前にする。Vim で使わない組み合わせ(⌘・Alt・ほとんどの Ctrl)は null(アプリのショートカットに任せる) */
export function keyName(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null
  if (e.ctrlKey) {
    const k = e.key.toLowerCase()
    if (k === '[') return '<Esc>'
    if (k === 'r' || k === 'd' || k === 'u') return `<C-${k}>`
    return null
  }
  if (e.key in SPECIAL) return SPECIAL[e.key]
  if (e.key.length === 1 || [...e.key].length === 1) return e.key
  return null
}

// ---- コマンドの読み取り ----

type Motion = { k: string; arg?: string }
type Target = { kind: 'motion'; m: Motion } | { kind: 'obj'; around: boolean; ch: string } | { kind: 'line' }
type Cmd =
  | { t: 'motion'; m: Motion; count: number; hasCount: boolean }
  | { t: 'op'; op: string; target: Target; count: number; hasCount: boolean }
  | { t: 'obj'; around: boolean; ch: string; count: number }
  | { t: 'action'; a: string; arg?: string; count: number; hasCount: boolean }

type Parsed = 'pending' | 'invalid' | { cmd: Cmd; countLen: number }

const MOTIONS = new Set([
  'h', 'l', 'j', 'k', 'gj', 'gk', 'w', 'W', 'b', 'B', 'e', 'E', 'ge', 'gE', '0', '^', '$', 'g_', 'gg', 'G',
  'f', 'F', 't', 'T', ';', ',', '%', '{', '}', '<CR>', '+', '-', '_', '<BS>', ' ', '<C-d>', '<C-u>',
])
const ARG_MOTIONS = new Set(['f', 'F', 't', 'T'])
const OPERATORS = new Set(['d', 'c', 'y', '>', '<', 'gu', 'gU', 'g~'])
const NORMAL_ACTIONS = new Set([
  'x', 'X', 's', 'S', 'D', 'C', 'Y', 'p', 'P', 'u', '<C-r>', '.', 'i', 'a', 'I', 'A', 'o', 'O', 'v', 'V',
  'J', 'gJ', 'r', '~', 'n', 'N', '*', '#', '/', '?', 'gi', '<Esc>', 'zz',
])
const VISUAL_ACTIONS = new Set([
  'd', 'x', 'X', 'D', 'y', 'Y', 'c', 's', 'C', 'S', 'R', '>', '<', '~', 'u', 'U', 'J', 'gJ', 'o', 'O', 'p', 'P',
  'r', 'I', 'A', '<Esc>', 'v', 'V', 'gu', 'gU', 'g~', 'n', 'N', '*', '#', '/', '?',
])
/** 文書を書き換える(「.」で繰り返す)コマンド */
const CHANGE_ACTIONS = new Set(['x', 'X', 's', 'S', 'D', 'C', 'p', 'P', 'i', 'a', 'I', 'A', 'o', 'O', 'J', 'gJ', 'r', '~', 'gi'])

/** keys[i] から、g・z で始まる 2文字のものも 1つのキーとして読む */
function token(keys: string[], i: number): { tok: string; next: number } | 'pending' {
  const k = keys[i]
  if (k === undefined) return 'pending'
  if (k === 'g' || k === 'z') {
    if (keys[i + 1] === undefined) return 'pending'
    return { tok: k + keys[i + 1], next: i + 2 }
  }
  return { tok: k, next: i + 1 }
}

function readCount(keys: string[], i: number, allowZero: boolean): { n: number | null; next: number } {
  let s = ''
  while (i < keys.length && /^[0-9]$/.test(keys[i]) && (s !== '' || allowZero || keys[i] !== '0')) s += keys[i++]
  return { n: s ? Number(s) : null, next: i }
}

function parseMotion(keys: string[], i: number): { m: Motion; next: number } | 'pending' | 'invalid' {
  const t = token(keys, i)
  if (t === 'pending') return t
  if (!MOTIONS.has(t.tok)) return 'invalid'
  if (ARG_MOTIONS.has(t.tok)) {
    const arg = keys[t.next]
    if (arg === undefined) return 'pending'
    if (arg.startsWith('<')) return 'invalid'
    return { m: { k: t.tok, arg }, next: t.next + 1 }
  }
  return { m: { k: t.tok }, next: t.next }
}

export function parse(keys: string[], visual: boolean): Parsed {
  const c1 = readCount(keys, 0, false)
  const countLen = c1.next
  const t = token(keys, c1.next)
  if (t === 'pending') return 'pending'
  const count = c1.n ?? 1
  const hasCount = c1.n !== null

  if (visual) {
    if (t.tok === 'i' || t.tok === 'a') {
      const ch = keys[t.next]
      if (ch === undefined) return 'pending'
      return { cmd: { t: 'obj', around: t.tok === 'a', ch, count }, countLen }
    }
    if (VISUAL_ACTIONS.has(t.tok)) {
      if (t.tok === 'r') {
        const arg = keys[t.next]
        if (arg === undefined) return 'pending'
        if (arg.startsWith('<')) return 'invalid'
        return { cmd: { t: 'action', a: 'r', arg, count, hasCount }, countLen }
      }
      return { cmd: { t: 'action', a: t.tok, count, hasCount }, countLen }
    }
  } else if (OPERATORS.has(t.tok)) {
    const op = t.tok
    const c2 = readCount(keys, t.next, false)
    const total = count * (c2.n ?? 1)
    const has = hasCount || c2.n !== null
    const k = keys[c2.next]
    if (k === undefined) return 'pending'
    const last = op[op.length - 1]
    // dd・cc・yy・>>・<<・guu(gugu)・gUU・g~~
    if (k === last && (op.length === 1 || op === 'gu' || op === 'gU' || op === 'g~'))
      return { cmd: { t: 'op', op, target: { kind: 'line' }, count: total, hasCount: has }, countLen }
    if (op.length === 2 && k === 'g') {
      const k2 = keys[c2.next + 1]
      if (k2 === undefined) return 'pending'
      if (k2 === last) return { cmd: { t: 'op', op, target: { kind: 'line' }, count: total, hasCount: has }, countLen }
    }
    if (k === 'i' || k === 'a') {
      const ch = keys[c2.next + 1]
      if (ch === undefined) return 'pending'
      return { cmd: { t: 'op', op, target: { kind: 'obj', around: k === 'a', ch }, count: total, hasCount: has }, countLen }
    }
    const m = parseMotion(keys, c2.next)
    if (typeof m === 'string') return m
    return { cmd: { t: 'op', op, target: { kind: 'motion', m: m.m }, count: total, hasCount: has }, countLen }
  }

  if (!visual && NORMAL_ACTIONS.has(t.tok)) {
    if (t.tok === 'r') {
      const arg = keys[t.next]
      if (arg === undefined) return 'pending'
      if (arg.startsWith('<')) return 'invalid'
      return { cmd: { t: 'action', a: 'r', arg, count, hasCount }, countLen }
    }
    return { cmd: { t: 'action', a: t.tok, count, hasCount }, countLen }
  }
  const m = parseMotion(keys, c1.next)
  if (typeof m === 'string') return m
  return { cmd: { t: 'motion', m: m.m, count, hasCount }, countLen }
}

// ---- 動き ----

type MotionResult = { cur: Cur; kind: 'excl' | 'incl' | 'line' }

/** 削除・コピーで覚えておく内容 */
type Register = { linewise: boolean; text: string; slice: Slice | null }

type Change = { keys: string[]; count: number | null; text: string | null }

/** 1つのエディタの Vim の状態のうち、文書の状態に入れないもの */
export class VimController {
  pending: string[] = []
  goalCol: number | null = null
  lastFind: { kind: FindKind; ch: string } | null = null
  register: Register | null = null
  lastChange: Change | null = null
  recording: { keys: string[]; count: number | null } | null = null
  replaying = false
  lastSearch = ''
  lastInsert: number | null = null
  view: EditorView | null = null
  status: HTMLElement | null = null

  // ---- 入口 ----

  keydown(view: EditorView, e: KeyboardEvent): boolean {
    this.view = view
    if (!vimEnabled() || e.defaultPrevented) return false
    // 変換中のキーは IME のもの。ノーマルモードでも触らない
    if (e.isComposing || e.keyCode === 229) return false
    const target = e.target as HTMLElement | null
    // 本文の中の入力欄(コードの言語など)に打っているときは、その欄に任せる
    if (target && target !== view.dom && target.closest('input, textarea, select, [contenteditable="true"]:not(.ProseMirror)')) return false
    const mode = vimState(view.state).mode
    const key = keyName(e)
    if (mode === 'insert') {
      if (key !== '<Esc>') return false
      e.preventDefault()
      this.escapeInsert(view)
      return true
    }
    if (key === null) {
      // 修飾キーだけ(Shift など)は、打ちかけのコマンドを捨てない
      return false
    }
    e.preventDefault()
    this.feed(view, key)
    return true
  }

  /** キーを 1つ受け取る(「.」の繰り返しでも使う) */
  feed(view: EditorView, key: string): void {
    const mode = vimState(view.state).mode
    if (mode === 'insert') {
      if (key === '<Esc>') this.escapeInsert(view)
      return
    }
    this.pending.push(key)
    if (key === '<Esc>' && this.pending.length > 1) {
      this.pending = []
      this.renderStatus()
      return
    }
    const visual = mode === 'visual' || mode === 'vline'
    const r = parse(this.pending, visual)
    if (r === 'pending') {
      this.renderStatus()
      return
    }
    const keys = this.pending
    this.pending = []
    if (r !== 'invalid') {
      const isChange =
        !visual && ((r.cmd.t === 'op' && r.cmd.op !== 'y') || (r.cmd.t === 'action' && CHANGE_ACTIONS.has(r.cmd.a)))
      if (isChange && !this.replaying && (r.cmd.t === 'op' || r.cmd.t === 'action'))
        this.recording = { keys: keys.slice(r.countLen), count: r.cmd.hasCount ? r.cmd.count : null }
      try {
        this.run(view, r.cmd)
      } finally {
        if (this.recording && vimState(view.state).mode !== 'insert') {
          this.lastChange = { ...this.recording, text: null }
          this.recording = null
        }
      }
    }
    this.renderStatus()
  }

  private run(view: EditorView, cmd: Cmd): void {
    const mode = vimState(view.state).mode
    if (mode === 'visual' || mode === 'vline') return this.runVisual(view, cmd)
    if (cmd.t === 'motion') {
      const r = this.motion(view, cmd.m, cmd.count, cmd.hasCount, null)
      if (r) this.moveTo(view, posOf(linesOf(view.state.doc), r.cur))
      return
    }
    if (cmd.t === 'op') return this.operator(view, cmd.op, cmd.target, cmd.count, cmd.hasCount)
    if (cmd.t === 'action') return this.action(view, cmd.a, cmd.count, cmd.hasCount, cmd.arg)
  }

  // ---- 動き ----

  private motion(view: EditorView, m: Motion, count: number, hasCount: boolean, op: string | null): MotionResult | null {
    const { doc } = view.state
    const lines = linesOf(doc)
    if (lines.length === 0) return null
    const head = vimState(view.state).mode === 'normal' ? view.state.selection.head : vimState(view.state).head
    const cur = curOf(lines, head)
    const line = lines[cur.li]
    const lastLine = lines.length - 1
    const keepGoal = ['j', 'k', '<C-d>', '<C-u>', 'gj', 'gk'].includes(m.k)
    if (!keepGoal) this.goalCol = null
    const vertical = (li: number): Cur => {
      const target = Math.max(0, Math.min(lastLine, li))
      if (this.goalCol === null) this.goalCol = columnOf(line.text, cur.off)
      const t = lines[target].text
      return { li: target, off: this.goalCol === Infinity ? lastGraphemeStart(t) : offsetOfColumn(t, this.goalCol) }
    }
    const fnb = (li: number): Cur => ({ li, off: firstNonBlank(lines[li].text) })
    switch (m.k) {
      case 'h':
      case '<BS>': {
        let off = cur.off
        for (let n = 0; n < count && off > 0; n++) off = prevGrapheme(line.text, off)
        return off === cur.off && !op ? null : { cur: { li: cur.li, off }, kind: 'excl' }
      }
      case 'l':
      case ' ': {
        let off = cur.off
        const limit = op ? line.text.length : lastGraphemeStart(line.text)
        for (let n = 0; n < count && off < limit; n++) off = Math.min(limit, nextGrapheme(line.text, off))
        return { cur: { li: cur.li, off }, kind: 'excl' }
      }
      case 'j':
        return cur.li + count > lastLine && !op && cur.li === lastLine ? null : { cur: vertical(cur.li + count), kind: 'line' }
      case 'k':
        return cur.li === 0 && !op ? null : { cur: vertical(cur.li - count), kind: 'line' }
      case 'gj':
      case 'gk': {
        let pos = head
        for (let n = 0; n < count; n++) pos = this.visualLine(view, pos, m.k === 'gj' ? 1 : -1)
        return { cur: curOf(lines, pos), kind: 'excl' }
      }
      case '<C-d>':
      case '<C-u>':
        return { cur: curOf(lines, this.halfPage(view, head, m.k === '<C-d>' ? 1 : -1)), kind: 'line' }
      case 'w':
      case 'W': {
        const big = m.k === 'W'
        // cw は ce と同じ(単語の後ろの空白は消さない)
        if (op === 'c' && charAt(lines, cur) !== '\n' && !/^[ \t　]$/.test(charAt(lines, cur))) {
          let p = isWordEnd(lines, cur, big) ? cur : wordEnd(lines, cur, big)
          for (let n = 1; n < count; n++) p = wordEnd(lines, p, big)
          return { cur: p, kind: 'incl' }
        }
        let p = cur
        for (let n = 0; n < count; n++) {
          const q = wordForward(lines, p, big)
          // 演算子の最後の 1回は、次の行まで行かずに行の終わりで止める
          if (op && n === count - 1 && q.li > p.li) {
            p = { li: p.li, off: lines[p.li].text.length }
            break
          }
          p = q
        }
        if (!op && p.off >= lines[p.li].text.length) p = { li: p.li, off: normalOff(lines[p.li].text, p.off) }
        return { cur: p, kind: 'excl' }
      }
      case 'e':
      case 'E': {
        let p = cur
        for (let n = 0; n < count; n++) p = wordEnd(lines, p, m.k === 'E')
        return { cur: p, kind: 'incl' }
      }
      case 'b':
      case 'B': {
        let p = cur
        for (let n = 0; n < count; n++) p = wordBackward(lines, p, m.k === 'B')
        return { cur: p, kind: 'excl' }
      }
      case 'ge':
      case 'gE': {
        let p = cur
        for (let n = 0; n < count; n++) p = wordEndBackward(lines, p, m.k === 'gE')
        return { cur: p, kind: 'incl' }
      }
      case '0':
        return { cur: { li: cur.li, off: 0 }, kind: 'excl' }
      case '^':
        return { cur: fnb(cur.li), kind: 'excl' }
      case '$': {
        const li = Math.min(lastLine, cur.li + count - 1)
        this.goalCol = Infinity
        const t = lines[li].text
        return op ? { cur: { li, off: t.length }, kind: 'excl' } : { cur: { li, off: lastGraphemeStart(t) }, kind: 'incl' }
      }
      case 'g_': {
        const li = Math.min(lastLine, cur.li + count - 1)
        return { cur: { li, off: lastNonBlank(lines[li].text) }, kind: 'incl' }
      }
      case 'gg':
        return { cur: fnb(hasCount ? Math.min(lastLine, count - 1) : 0), kind: 'line' }
      case 'G':
        return { cur: fnb(hasCount ? Math.min(lastLine, count - 1) : lastLine), kind: 'line' }
      case '<CR>':
      case '+':
        return cur.li + count > lastLine && !op ? null : { cur: fnb(Math.min(lastLine, cur.li + count)), kind: 'line' }
      case '-':
        return cur.li === 0 && !op ? null : { cur: fnb(Math.max(0, cur.li - count)), kind: 'line' }
      case '_':
        return { cur: fnb(Math.min(lastLine, cur.li + count - 1)), kind: 'line' }
      case 'f':
      case 'F':
      case 't':
      case 'T':
      case ';':
      case ',': {
        let kind: FindKind
        let ch: string
        if (m.k === ';' || m.k === ',') {
          if (!this.lastFind) return null
          ch = this.lastFind.ch
          kind = this.lastFind.kind
          if (m.k === ',') kind = ({ f: 'F', F: 'f', t: 'T', T: 't' } as const)[kind]
        } else {
          kind = m.k as FindKind
          ch = m.arg ?? ''
          this.lastFind = { kind, ch }
        }
        const off = findInLine(line.text, cur.off, kind, ch, count, m.k === ';' || m.k === ',')
        if (off === null) return null
        return { cur: { li: cur.li, off }, kind: kind === 'f' || kind === 't' ? 'incl' : 'excl' }
      }
      case '%': {
        const c = matchBracket(lines, cur)
        return c ? { cur: c, kind: 'incl' } : null
      }
      case '{':
      case '}': {
        const li = paragraphMove(lines, cur.li, m.k === '}' ? 1 : -1, count)
        const atEnd = m.k === '}' && li === lastLine && lines[li].text.length > 0
        return { cur: { li, off: atEnd ? (op ? lines[li].text.length : lastGraphemeStart(lines[li].text)) : 0 }, kind: 'excl' }
      }
    }
    return null
  }

  /** 画面の上の 1行下・上(折り返した行も 1行に数える)。測れないときは文書の行で動く */
  private visualLine(view: EditorView, pos: number, dir: 1 | -1): number {
    const lines = linesOf(view.state.doc)
    try {
      const start = view.coordsAtPos(pos)
      const x = start.left
      for (let dy = 2; dy < 400; dy += 4) {
        const y = dir > 0 ? start.bottom + dy : start.top - dy
        const hit = view.posAtCoords({ left: x, top: y })
        if (!hit || hit.pos === pos) continue
        const c = view.coordsAtPos(hit.pos)
        if (dir > 0 ? c.top >= start.bottom - 2 : c.bottom <= start.top + 2) return clampNormal(lines, hit.pos)
      }
    } catch {
      // 測れない(画面に出ていない)
    }
    const c = curOf(lines, pos)
    const li = Math.max(0, Math.min(lines.length - 1, c.li + dir))
    return lines[li].from + offsetOfColumn(lines[li].text, columnOf(lines[c.li].text, c.off))
  }

  /** Ctrl+D / Ctrl+U。画面を半分動かし、カーソルも画面の上の同じ高さへ */
  private halfPage(view: EditorView, pos: number, dir: 1 | -1): number {
    const lines = linesOf(view.state.doc)
    const scroller = scrollParent(view.dom)
    const height = scroller ? scroller.clientHeight : window.innerHeight
    try {
      const at = view.coordsAtPos(pos)
      if (scroller) scroller.scrollBy({ top: (dir * height) / 2, behavior: 'instant' })
      else window.scrollBy({ top: (dir * height) / 2, behavior: 'instant' })
      const hit = view.posAtCoords({ left: at.left, top: Math.min(Math.max(at.top + 2, 0), window.innerHeight - 4) })
      if (hit && hit.pos !== pos) return clampNormal(lines, hit.pos)
    } catch {
      // 測れないときは行で動く
    }
    const c = curOf(lines, pos)
    const li = Math.max(0, Math.min(lines.length - 1, c.li + dir * 15))
    return lines[li].from + firstNonBlank(lines[li].text)
  }

  /** ノーマルモードのカーソルを pos へ(行の最後の文字より右へは行かない) */
  private moveTo(view: EditorView, pos: number): void {
    const lines = linesOf(view.state.doc)
    const p = clampNormal(lines, pos)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, p)).setMeta(vimKey, { vim: true }).scrollIntoView())
  }

  // ---- 範囲 ----

  /** 演算子が働く範囲。文字の範囲(from・to は文書の位置)か、行の範囲 */
  private targetRange(view: EditorView, target: Target, count: number, hasCount: boolean, op: string):
    | { kind: 'char'; from: number; to: number; cursor?: number }
    | { kind: 'line'; range: LineRange }
    | null {
    const { doc, selection } = view.state
    const lines = linesOf(doc)
    if (lines.length === 0) return null
    const cur = curOf(lines, selection.head)
    if (target.kind === 'line') {
      return { kind: 'line', range: { first: cur.li, last: Math.min(lines.length - 1, cur.li + count - 1) } }
    }
    if (target.kind === 'obj') {
      const r = textObject(lines, cur, target.ch, target.around)
      if (!r) return null
      if ('first' in r) return { kind: 'line', range: r }
      return { kind: 'char', from: posOf(lines, r.start), to: posOf(lines, r.end) }
    }
    const r = this.motion(view, target.m, count, hasCount, op)
    if (!r) return null
    if (r.kind === 'line') return { kind: 'line', range: { first: Math.min(cur.li, r.cur.li), last: Math.max(cur.li, r.cur.li) } }
    let a = posOf(lines, cur)
    let b = posOf(lines, r.cur)
    if (b < a) [a, b] = [b, a]
    if (r.kind === 'incl') {
      const c = curOf(lines, b)
      b = lines[c.li].from + nextGrapheme(lines[c.li].text, c.off)
    }
    return { kind: 'char', from: a, to: b }
  }

  // ---- 演算子 ----

  private operator(view: EditorView, op: string, target: Target, count: number, hasCount: boolean): void {
    const r = this.targetRange(view, target, count, hasCount, op)
    if (!r) return
    if (r.kind === 'line') this.lineOp(view, op, r.range.first, r.range.last)
    else this.charOp(view, op, r.from, r.to)
  }

  private charOp(view: EditorView, op: string, from: number, to: number): void {
    const { state } = view
    if (op === '>' || op === '<') {
      const lines = linesOf(state.doc)
      return this.lineOp(view, op, lineIndexAt(lines, from), lineIndexAt(lines, Math.max(from, to - 1)))
    }
    if (op === 'y') {
      this.register = charRegister(state.doc, from, to)
      this.moveTo(view, from)
      return
    }
    if (op === 'gu' || op === 'gU' || op === 'g~') {
      const tr = transformText(state.tr, from, to, caseFn(op))
      this.commit(view, tr, from)
      return
    }
    // d・c
    if (from < to) this.register = charRegister(state.doc, from, to)
    const tr = state.tr
    if (from < to && !hasBlockAtomBetween(state.doc, from, to)) tr.delete(from, to)
    else if (from < to) return
    if (op === 'c') return this.enterInsert(view, tr.mapping.map(from), tr)
    this.commit(view, tr, tr.mapping.map(from))
  }

  private lineOp(view: EditorView, op: string, first: number, last: number): void {
    const { state } = view
    const lines = linesOf(state.doc)
    if (op === '>' || op === '<') return this.shiftLines(view, first, last, op === '>' ? 1 : -1)
    if (op === 'gu' || op === 'gU' || op === 'g~') {
      const tr = transformText(state.tr, lines[first].from, lines[last].to, caseFn(op))
      this.commit(view, tr, lines[first].from + firstNonBlank(lines[first].text))
      return
    }
    const unit = lineUnits(state.doc, lines, first, last)
    this.register = { linewise: true, text: unit.text, slice: unit.slice }
    if (op === 'y') {
      const cur = curOf(lines, state.selection.head)
      if (cur.li !== first) this.moveTo(view, lines[first].from + offsetOfColumn(lines[first].text, columnOf(lines[cur.li].text, cur.off)))
      return
    }
    if (op === 'c') {
      // 行の中身だけを消して、最初の行(ブロック)を残す
      const tr = state.tr
      const from = lines[first].from + (lines[first].code ? leadingSpaces(lines[first].text) : 0)
      if (unit.inTable) for (let i = last; i >= first; i--) tr.delete(lines[i].from, lines[i].to)
      else if (from < lines[last].to) tr.delete(from, lines[last].to)
      return this.enterInsert(view, tr.mapping.map(from), tr)
    }
    // d
    const tr = state.tr
    deleteLineUnits(tr, unit)
    const newLines = buildLines(tr.doc)
    if (newLines.length === 0) return this.commit(view, tr, 0)
    let target: number
    if (unit.inTable) target = lineIndexAt(newLines, tr.mapping.map(unit.from))
    else if (unit.partial && unit.delFrom < unit.from) target = lineIndexAt(newLines, tr.mapping.map(unit.delFrom, -1)) // コードの最後の行を消した → 上の行
    else {
      const at = tr.mapping.map(unit.delFrom, -1)
      target = newLines.findIndex((l) => l.from >= at)
      if (target < 0) target = newLines.length - 1
    }
    this.commit(view, tr, newLines[target].from + firstNonBlank(newLines[target].text))
  }

  private shiftLines(view: EditorView, first: number, last: number, dir: 1 | -1, times = 1): void {
    const { state } = view
    const lines = linesOf(state.doc)
    const listItem = state.schema.nodes.list_item
    const headBefore = state.selection.head
    // コードの行は空白 2つ分ずらす
    if (lines[first].code && lines[last].code && lines[first].blockPos === lines[last].blockPos) {
      const tr = state.tr
      for (let i = last; i >= first; i--) {
        const l = lines[i]
        for (let n = 0; n < times; n++) {
          if (dir > 0) {
            if (l.text.length > 0) tr.insertText('  ', tr.mapping.map(l.from))
          } else {
            const from = tr.mapping.map(l.from)
            const lead = Math.min(2, leadingSpaces(tr.doc.textBetween(from, tr.mapping.map(l.to))))
            if (lead > 0) tr.delete(from, from + lead)
          }
        }
      }
      return this.commit(view, tr, tr.mapping.map(lines[first].from) + firstNonBlank(lines[first].text.trimStart()))
    }
    if (!listItem) return
    // リストの項目なら、1段深く・浅くする
    const from = lines[first].from
    const to = lines[last].to
    for (let n = 0; n < times; n++) {
      const st = view.state
      const sel = st.tr.setSelection(TextSelection.create(st.doc, Math.min(from, st.doc.content.size), Math.min(to, st.doc.content.size)))
      const withSel = st.apply(sel)
      const cmd = dir > 0 ? sinkListItem(listItem) : liftListItem(listItem)
      let applied: Transaction | null = null
      cmd(withSel, (tr) => {
        applied = tr
      })
      if (!applied) break
      // 選んだ範囲の変更と、ずらす変更をまとめて 1回にする
      const tr = st.tr
      for (const step of (applied as Transaction).steps) tr.step(step)
      view.dispatch(tr.setMeta(vimKey, { vim: true }))
    }
    const lines2 = linesOf(view.state.doc)
    const pos = clampNormal(lines2, Math.min(view.state.doc.content.size, headBefore))
    this.moveTo(view, lines2[lineIndexAt(lines2, pos)].from + firstNonBlank(lines2[lineIndexAt(lines2, pos)].text))
  }

  // ---- そのほかのコマンド ----

  private action(view: EditorView, a: string, count: number, hasCount: boolean, arg?: string): void {
    const { state } = view
    const lines = linesOf(state.doc)
    if (lines.length === 0) return
    const head = state.selection.head
    const cur = curOf(lines, head)
    const line = lines[cur.li]
    const motion = (k: string): Target => ({ kind: 'motion', m: { k } })
    switch (a) {
      case '<Esc>':
        return
      case 'x':
        if (line.text.length === 0) return
        return this.operator(view, 'd', motion('l'), count, hasCount)
      case 'X':
        if (cur.off === 0) return
        return this.operator(view, 'd', motion('h'), count, hasCount)
      case 's':
        if (line.text.length === 0) return this.enterInsert(view, head)
        return this.operator(view, 'c', motion('l'), count, hasCount)
      case 'S':
        return this.operator(view, 'c', { kind: 'line' }, count, hasCount)
      case 'D':
        return this.operator(view, 'd', motion('$'), count, hasCount)
      case 'C':
        return this.operator(view, 'c', motion('$'), count, hasCount)
      case 'Y':
        return this.operator(view, 'y', { kind: 'line' }, count, hasCount)
      case 'p':
      case 'P':
        return this.paste(view, a === 'p', count)
      case 'u':
      case '<C-r>': {
        for (let n = 0; n < count; n++) {
          const ok = (a === 'u' ? undo : redo)(view.state, view.dispatch)
          if (!ok) break
        }
        const l2 = linesOf(view.state.doc)
        if (l2.length > 0) this.moveTo(view, Math.min(view.state.selection.from, view.state.doc.content.size))
        return
      }
      case '.':
        return this.repeat(view, hasCount ? count : null)
      case 'i':
        return this.enterInsert(view, head)
      case 'a':
        return this.enterInsert(view, line.text.length === 0 ? head : line.from + nextGrapheme(line.text, cur.off))
      case 'I':
        return this.enterInsert(view, line.from + leadingSpaces(line.text))
      case 'A':
        return this.enterInsert(view, line.to)
      case 'gi':
        return this.enterInsert(view, this.lastInsert !== null ? Math.min(this.lastInsert, state.doc.content.size) : head)
      case 'o':
      case 'O':
        return this.openLine(view, cur.li, a === 'o')
      case 'v':
      case 'V':
        view.dispatch(
          state.tr.setMeta(vimKey, { vim: true, mode: a === 'v' ? 'visual' : 'vline', anchor: head, head } satisfies Meta),
        )
        this.syncVisualSelection(view)
        return
      case 'J':
      case 'gJ':
        return this.joinLines(view, cur.li, Math.max(2, count) - 1, a === 'J')
      case 'r': {
        if (!arg || line.text.length === 0) return
        let end = cur.off
        for (let n = 0; n < count; n++) {
          if (end >= line.text.length) return // 足りないときは何もしない(Vim と同じ)
          end = nextGrapheme(line.text, end)
        }
        const tr = state.tr.insertText(arg.repeat(count), head, line.from + end)
        return this.commit(view, tr, head + arg.length * count - arg.length)
      }
      case '~': {
        if (line.text.length === 0) return
        let end = cur.off
        for (let n = 0; n < count && end < line.text.length; n++) end = nextGrapheme(line.text, end)
        const tr = transformText(state.tr, head, line.from + end, toggleCase)
        const l2 = buildLines(tr.doc)
        const c2 = curOf(l2, tr.mapping.map(line.from + end))
        return this.commit(view, tr, l2[c2.li].from + normalOff(l2[c2.li].text, c2.off))
      }
      case 'n':
      case 'N':
        return this.searchNext(view, a === 'n' ? 1 : -1, count)
      case '*':
      case '#': {
        const w = wordObject(lines, cur, false, false)
        if (!w) return
        const word = line.text.slice(w.start.off, w.end.off).trim()
        if (!word) return
        this.lastSearch = word
        return this.searchNext(view, a === '*' ? 1 : -1, count)
      }
      case '/':
      case '?':
        openFind()
        return
      case 'zz':
        try {
          const dom = view.domAtPos(head)
          const el = dom.node instanceof Element ? dom.node : dom.node.parentElement
          el?.scrollIntoView({ block: 'center', behavior: 'instant' })
        } catch {
          // 画面に出ていない
        }
        return
    }
  }

  // ---- ビジュアルモード ----

  private visualRange(state: EditorState): { from: number; to: number; first: number; last: number; linewise: boolean } {
    const s = vimState(state)
    const lines = linesOf(state.doc)
    const a = Math.min(s.anchor, s.head)
    const b = Math.max(s.anchor, s.head)
    const cb = curOf(lines, b)
    const end = lines[cb.li].from + (lines[cb.li].text.length === 0 ? 0 : nextGrapheme(lines[cb.li].text, cb.off))
    return { from: a, to: Math.max(a, end), first: lineIndexAt(lines, a), last: cb.li, linewise: s.mode === 'vline' }
  }

  /** ProseMirror の選択を、ビジュアルモードの範囲に合わせる(⌘C でコピーできるように) */
  private syncVisualSelection(view: EditorView): void {
    const s = vimState(view.state)
    const { from, to, first, last, linewise } = this.visualRange(view.state)
    const lines = linesOf(view.state.doc)
    const [f, t] = linewise ? [lines[first].from, lines[last].to] : [from, to]
    const forward = s.head >= s.anchor
    const sel = TextSelection.create(view.state.doc, forward ? f : t, forward ? t : f)
    view.dispatch(view.state.tr.setSelection(sel).setMeta(vimKey, { vim: true }).scrollIntoView())
  }

  private setVisual(view: EditorView, meta: Meta): void {
    view.dispatch(view.state.tr.setMeta(vimKey, { vim: true, ...meta }))
    this.syncVisualSelection(view)
  }

  private toNormal(view: EditorView, pos: number, tr?: Transaction): void {
    const t = tr ?? view.state.tr
    const lines = buildLines(t.doc)
    const p = lines.length > 0 ? clampNormal(lines, Math.min(pos, t.doc.content.size)) : 0
    t.setSelection(TextSelection.create(t.doc, p)).setMeta(vimKey, { vim: true, mode: 'normal' } satisfies Meta).scrollIntoView()
    view.dispatch(t)
  }

  private runVisual(view: EditorView, cmd: Cmd): void {
    const { state } = view
    const s = vimState(state)
    const lines = linesOf(state.doc)
    if (cmd.t === 'motion') {
      const r = this.motion(view, cmd.m, cmd.count, cmd.hasCount, null)
      if (!r) return
      const p = clampNormal(lines, posOf(lines, r.cur))
      return this.setVisual(view, { head: p })
    }
    if (cmd.t === 'obj') {
      const cur = curOf(lines, s.head)
      const r = textObject(lines, cur, cmd.ch, cmd.around)
      if (!r) return
      if ('first' in r) return this.setVisual(view, { mode: 'vline', anchor: lines[r.first].from, head: lines[r.last].from })
      const end = posOf(lines, r.end)
      const ce = curOf(lines, end)
      const head = ce.off > 0 ? lines[ce.li].from + prevGrapheme(lines[ce.li].text, ce.off) : end
      return this.setVisual(view, { anchor: posOf(lines, r.start), head: Math.max(posOf(lines, r.start), head) })
    }
    if (cmd.t !== 'action') return
    const { from, to, first, last, linewise } = this.visualRange(state)
    const a = cmd.a
    switch (a) {
      case '<Esc>':
        return this.toNormal(view, s.head)
      case 'v':
      case 'V': {
        const want: Mode = a === 'v' ? 'visual' : 'vline'
        if (s.mode === want) return this.toNormal(view, s.head)
        return this.setVisual(view, { mode: want })
      }
      case 'o':
      case 'O':
        return this.setVisual(view, { anchor: s.head, head: s.anchor })
      case 'd':
      case 'x':
        if (linewise) return this.afterVisual(view, () => this.lineOp(view, 'd', first, last))
        return this.afterVisual(view, () => this.charOp(view, 'd', from, to))
      case 'X':
      case 'D':
        return this.afterVisual(view, () => this.lineOp(view, 'd', first, last))
      case 'y':
        if (linewise) return this.afterVisual(view, () => this.lineOp(view, 'y', first, last), lines[first].from)
        return this.afterVisual(view, () => this.charOp(view, 'y', from, to), from)
      case 'Y':
        return this.afterVisual(view, () => this.lineOp(view, 'y', first, last), lines[first].from)
      case 'c':
      case 's':
        if (linewise) return this.afterVisual(view, () => this.lineOp(view, 'c', first, last))
        return this.afterVisual(view, () => this.charOp(view, 'c', from, to))
      case 'C':
      case 'S':
      case 'R':
        return this.afterVisual(view, () => this.lineOp(view, 'c', first, last))
      case '>':
      case '<':
        return this.afterVisual(view, () => this.shiftLines(view, first, last, a === '>' ? 1 : -1, cmd.count))
      case '~':
      case 'g~':
      case 'u':
      case 'gu':
      case 'U':
      case 'gU': {
        const op = a === '~' || a === 'g~' ? 'g~' : a === 'u' || a === 'gu' ? 'gu' : 'gU'
        const [f, t] = linewise ? [lines[first].from, lines[last].to] : [from, to]
        return this.afterVisual(view, () => this.commit(view, transformText(view.state.tr, f, t, caseFn(op)), f))
      }
      case 'J':
      case 'gJ':
        return this.afterVisual(view, () => this.joinLines(view, first, Math.max(1, last - first), a === 'J'))
      case 'r': {
        const ch = cmd.arg
        if (!ch) return
        const [f, t] = linewise ? [lines[first].from, lines[last].to] : [from, to]
        return this.afterVisual(view, () => this.commit(view, transformText(view.state.tr, f, t, (x) => replaceGraphemes(x, ch)), f))
      }
      case 'I':
        return this.afterVisual(view, () => this.enterInsert(view, linewise ? lines[first].from + leadingSpaces(lines[first].text) : from))
      case 'A':
        return this.afterVisual(view, () => this.enterInsert(view, linewise ? lines[last].to : to))
      case 'p':
      case 'P': {
        const reg = this.register
        if (!reg) return
        return this.afterVisual(view, () => {
          const lastLine = last === lines.length - 1
          if (linewise) this.lineOp(view, 'd', first, last)
          else this.charOp(view, 'd', from, to)
          // P は消した文字で覚えている内容を上書きしない
          const deleted = this.register
          this.register = reg
          if (linewise) {
            // 消した行の場所へ入れる(最後の行まで消したなら、残った最後の行の下へ)
            const now = linesOf(view.state.doc)
            const atLine = Math.min(first, now.length - 1)
            this.paste(view, lastLine && first > 0, 1, now[atLine].from)
          } else {
            this.paste(view, false, 1, Math.min(from, view.state.doc.content.size))
          }
          if (a === 'p') this.register = deleted
        })
      }
      case 'n':
      case 'N':
      case '*':
      case '#':
      case '/':
      case '?':
        return
    }
  }

  /** ビジュアルモードでの操作のあと、ノーマルモードに戻す(挿入モードに入ったならそのまま) */
  private afterVisual(view: EditorView, fn: () => void, cursor?: number): void {
    // 先にノーマルモードへ戻す(選択は消すが、範囲はすでに計算済み)
    view.dispatch(view.state.tr.setMeta(vimKey, { vim: true, mode: 'normal' } satisfies Meta))
    const before = view.state
    fn()
    if (vimState(view.state).mode !== 'insert') {
      const pos = cursor !== undefined && view.state.doc === before.doc ? cursor : view.state.selection.from
      this.toNormal(view, pos)
    }
  }

  // ---- 挿入モード ----

  enterInsert(view: EditorView, pos: number, tr?: Transaction): void {
    const t = tr ?? view.state.tr
    const p = Math.max(0, Math.min(pos, t.doc.content.size))
    let sel: Selection
    try {
      sel = TextSelection.create(t.doc, p)
    } catch {
      sel = Selection.near(t.doc.resolve(p))
    }
    t.setSelection(sel)
      .setMeta(vimKey, { vim: true, mode: 'insert', insertStart: sel.head } satisfies Meta)
      .scrollIntoView()
    closeHistory(t)
    view.dispatch(t)
  }

  escapeInsert(view: EditorView): void {
    const { state } = view
    const s = vimState(state)
    const head = state.selection.head
    this.lastInsert = head
    if (this.recording) {
      let text: string | null = null
      if (s.insertStart !== null && head >= s.insertStart) text = state.doc.textBetween(s.insertStart, head, '\n', OBJ)
      this.lastChange = { ...this.recording, text }
      this.recording = null
    }
    const lines = linesOf(state.doc)
    const c = curOf(lines, head)
    const off = c.off > 0 ? prevGrapheme(lines[c.li].text, c.off) : 0
    const tr = state.tr
    closeHistory(tr)
    this.toNormal(view, lines[c.li].from + off, tr.setMeta(vimKey, { vim: true, insertStart: null } satisfies Meta))
    this.renderStatus()
  }

  /** o / O。Enter を押したのと同じ動き(リストなら次の項目、コードなら次の行)で行を足す */
  private openLine(view: EditorView, li: number, below: boolean): void {
    const lines = linesOf(view.state.doc)
    const line = lines[li]
    this.enterInsert(view, below ? line.to : line.from)
    pressEnter(view)
    if (!below) {
      const l2 = linesOf(view.state.doc)
      const c = curOf(l2, view.state.selection.head)
      if (c.li > 0) {
        const prevLine = l2[c.li - 1]
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, prevLine.to)).setMeta(vimKey, { vim: true, insertStart: prevLine.to } satisfies Meta))
      }
    } else {
      view.dispatch(view.state.tr.setMeta(vimKey, { vim: true, insertStart: view.state.selection.head } satisfies Meta))
    }
  }

  // ---- 貼り付け ----

  private paste(view: EditorView, after: boolean, count: number, at?: number): void {
    const reg = this.register
    if (!reg) return
    const { state } = view
    const lines = linesOf(state.doc)
    const cur = curOf(lines, at ?? state.selection.head)
    const line = lines[cur.li]
    const tr = state.tr
    if (reg.linewise) {
      const text = Array(count).fill(reg.text).join('\n')
      if (line.code || inTable(state.doc, line.from)) {
        // コードの中(と表のマスの中)には、文字の行として入れる
        if (line.code) {
          if (after) tr.insertText('\n' + text, line.to)
          else tr.insertText(text + '\n', line.from)
          const l2 = buildLines(tr.doc)
          const first = after ? cur.li + 1 : cur.li
          return this.commit(view, tr, l2[first].from + firstNonBlank(l2[first].text))
        }
        tr.insertText(text.replace(/\n/g, ' '), line.to)
        return this.commit(view, tr, line.to)
      }
      const u = lineUnits(state.doc, lines, cur.li, cur.li)
      const pos = after ? u.to : u.from
      let inserted = false
      if (reg.slice) {
        try {
          let p = pos
          for (let n = 0; n < count; n++) {
            const before = tr.steps.length
            tr.replace(p, p, reg.slice)
            p = tr.mapping.slice(before).map(p, 1)
          }
          inserted = tr.steps.length > 0
        } catch {
          inserted = false
        }
      }
      if (!inserted) {
        const para = state.schema.nodes.paragraph
        const nodes = text.split('\n').map((t) => para.create(null, t ? state.schema.text(t) : null))
        tr.insert(pos, Fragment.from(nodes))
      }
      const sel = Selection.findFrom(tr.doc.resolve(Math.min(tr.mapping.map(pos, -1), tr.doc.content.size)), 1, true)
      const l2 = buildLines(tr.doc)
      const start = sel ? sel.from : tr.mapping.map(pos, -1)
      const li = lineIndexAt(l2, start)
      return this.commit(view, tr, l2[li].from + firstNonBlank(l2[li].text))
    }
    // 文字の単位
    const pos = after && line.text.length > 0 ? line.from + nextGrapheme(line.text, cur.off) : line.from + cur.off
    const before = tr.steps.length
    if (line.code || !reg.slice || (reg.slice.openStart > 0 && inTable(state.doc, pos))) {
      tr.insertText(reg.text.repeat(count), pos)
    } else {
      let p = pos
      try {
        for (let n = 0; n < count; n++) {
          const b = tr.steps.length
          tr.replace(p, p, reg.slice)
          p = tr.mapping.slice(b).map(p, 1)
        }
      } catch {
        tr.insertText(reg.text.repeat(count), pos)
      }
    }
    const end = tr.mapping.slice(before).map(pos, 1)
    const l2 = buildLines(tr.doc)
    const c = curOf(l2, end)
    const off = c.off > 0 ? prevGrapheme(l2[c.li].text, c.off) : 0
    this.commit(view, tr, l2[c.li].from + off)
  }

  // ---- 行をつなぐ ----

  private joinLines(view: EditorView, li: number, times: number, space: boolean): void {
    let joinAt: number | null = null
    for (let n = 0; n < times; n++) {
      const { state } = view
      const lines = linesOf(state.doc)
      const target = joinAt === null ? li : lineIndexAt(lines, joinAt)
      if (target + 1 >= lines.length) break
      const L = lines[target]
      const N = lines[target + 1]
      if (hasBlockAtomBetween(state.doc, L.to, N.from)) break
      const ws = leadingSpaces(N.text)
      const lastCh = L.text.length > 0 ? L.text.slice(prevGrapheme(L.text, L.text.length)) : ''
      const firstCh = N.text.slice(ws, nextGrapheme(N.text, ws))
      const needSpace =
        space && L.text.length > 0 && !/[ \t　]$/.test(L.text) && firstCh !== '' && firstCh !== ')' && !isWide(lastCh) && !isWide(firstCh)
      const tr = state.tr
      try {
        tr.delete(L.to, N.from + ws)
      } catch {
        break
      }
      const at = tr.mapping.map(L.to, -1)
      if (needSpace) tr.insertText(' ', at)
      joinAt = at
      view.dispatch(tr.setMeta(vimKey, { vim: true }))
    }
    if (joinAt !== null) this.moveTo(view, joinAt)
  }

  // ---- 探す ----

  private searchNext(view: EditorView, dir: 1 | -1, count: number): void {
    const query = this.lastSearch
    if (!query) return
    const matches = findMatches(view.state.doc, query)
    if (matches.length === 0) return
    let pos = view.state.selection.head
    for (let n = 0; n < count; n++) {
      const next = dir > 0 ? (matches.find((m) => m.from > pos) ?? matches[0]) : ([...matches].reverse().find((m) => m.from < pos) ?? matches[matches.length - 1])
      pos = next.from
    }
    this.moveTo(view, pos)
  }

  // ---- 「.」 ----

  private repeat(view: EditorView, count: number | null): void {
    const change = this.lastChange
    if (!change) return
    const n = count ?? change.count
    const keys = [...(n !== null ? String(n).split('') : []), ...change.keys]
    this.replaying = true
    try {
      for (const k of keys) this.feed(view, k)
      if (vimState(view.state).mode === 'insert') {
        if (change.text) insertTyped(view, change.text)
        this.escapeInsert(view)
      }
    } finally {
      this.replaying = false
      this.pending = []
    }
  }

  // ---- 共通 ----

  /** 変更を反映し、ノーマルモードのカーソルを cursor へ */
  private commit(view: EditorView, tr: Transaction, cursor: number): void {
    closeHistory(tr)
    this.toNormal(view, tr.mapping.maps.length > 0 && cursor > tr.doc.content.size ? tr.doc.content.size : cursor, tr)
  }

  // ---- 表示 ----

  renderStatus(): void {
    const view = this.view
    const el = this.status
    if (!el) return
    if (!vimEnabled() || !view) {
      el.hidden = true
      return
    }
    el.hidden = false
    const mode = vimState(view.state).mode
    const label = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', vline: 'V-LINE' }[mode]
    el.dataset.mode = mode
    el.textContent = this.pending.length > 0 ? `${label}  ${this.pending.join('')}` : label
  }
}

// ---- 文書を変える小さな部品 ----

/** 改行のほかの文字を、1文字ずつ ch にする(ビジュアルモードの r) */
const replaceGraphemes = (s: string, ch: string) => {
  let out = ''
  for (let i = 0; i < s.length; ) {
    const j = nextGrapheme(s, i)
    out += s[i] === '\n' ? '\n' : ch
    i = j
  }
  return out
}

const leadingSpaces = (text: string) => (/^[ \t　]*/.exec(text)?.[0].length ?? 0)

const toggleCase = (t: string) =>
  [...t].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('')

const caseFn = (op: string): ((t: string) => string) =>
  op === 'gu' ? (t) => t.toLowerCase() : op === 'gU' ? (t) => t.toUpperCase() : toggleCase

/** from〜to の文字だけを fn で書き換える(太字などの書式はそのまま) */
function transformText(tr: Transaction, from: number, to: number, fn: (t: string) => string): Transaction {
  const parts: { from: number; to: number; text: string; node: PMNode }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return true
    const s = Math.max(from, pos)
    const e = Math.min(to, pos + node.nodeSize)
    if (s < e) parts.push({ from: s, to: e, text: node.text.slice(s - pos, e - pos), node })
    return false
  })
  for (const p of parts.reverse()) {
    const next = fn(p.text)
    if (next !== p.text) tr.replaceWith(p.from, p.to, tr.doc.type.schema.text(next, p.node.marks))
  }
  return tr
}

function charRegister(doc: PMNode, from: number, to: number): Register {
  return { linewise: false, text: doc.textBetween(from, to, '\n', OBJ), slice: doc.slice(from, to) }
}

const TABLE_CELLS = new Set(['table_cell', 'table_header'])

function inTable(doc: PMNode, pos: number): boolean {
  const $p = doc.resolve(pos)
  for (let d = $p.depth; d > 0; d--) if (TABLE_CELLS.has($p.node(d).type.name)) return true
  return false
}

/** from〜to の間に、画像・区切り線などの文字のないブロックが丸ごと入っているか */
function hasBlockAtomBetween(doc: PMNode, from: number, to: number): boolean {
  let found = false
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false
    if (node.isBlock && (node.isAtom || node.isLeaf) && pos >= from && pos + node.nodeSize <= to) found = true
    return !found
  })
  return found
}

/** 行の範囲を消す・覚えるときの、文書の範囲 */
type LineUnits = {
  from: number
  to: number
  /** 消すときの範囲(コードの行の一部なら、改行を含む) */
  delFrom: number
  delTo: number
  text: string
  slice: Slice | null
  /** コードブロックなどの、改行で分けた行の一部 */
  partial: boolean
  inTable: boolean
  /** 表のマスの中の行(行の中身だけを消す) */
  lines: Line[]
  wholeDoc: boolean
}

/** textblock から、ほかに子のない親(リストの項目・引用など)をたどり、消すときのまとまりにする */
function climb(doc: PMNode, blockPos: number, block: PMNode): { from: number; to: number } {
  let from = blockPos
  let to = blockPos + block.nodeSize
  const $p = doc.resolve(blockPos)
  for (let d = $p.depth; d > 0; d--) {
    const parent = $p.node(d)
    if (parent.childCount !== 1 || TABLE_CELLS.has(parent.type.name)) break
    from = $p.before(d)
    to = $p.after(d)
  }
  return { from, to }
}

function lineUnits(doc: PMNode, lines: Line[], first: number, last: number): LineUnits {
  const text = lines
    .slice(first, last + 1)
    .map((l) => l.text)
    .join('\n')
  const picked = lines.slice(first, last + 1)
  const sameBlock = lines[first].blockPos === lines[last].blockPos
  const blockLines = lines.filter((l) => l.blockPos === lines[first].blockPos)
  const tableish = picked.some((l) => inTable(doc, l.from))
  if (tableish) {
    return { from: lines[first].from, to: lines[last].to, delFrom: 0, delTo: 0, text, slice: null, partial: true, inTable: true, lines: picked, wholeDoc: false }
  }
  if (sameBlock && !lines[first].whole && picked.length < blockLines.length) {
    const isLastOfBlock = blockLines[blockLines.length - 1] === lines[last]
    const delFrom = isLastOfBlock ? lines[first - 1].to : lines[first].from
    const delTo = isLastOfBlock ? lines[last].to : lines[last + 1].from
    return { from: lines[first].from, to: lines[last].to, delFrom, delTo, text, slice: null, partial: true, inTable: false, lines: picked, wholeDoc: false }
  }
  const a = climb(doc, lines[first].blockPos, lines[first].block)
  const b = climb(doc, lines[last].blockPos, lines[last].block)
  const from = Math.min(a.from, b.from)
  const to = Math.max(a.to, b.to)
  const slice = doc.slice(from, to)
  // コードの行だけ(文字だけ)を覚えたものは、文字として貼る
  const allCode = picked.every((l) => l.code) && sameBlock
  return {
    from,
    to,
    delFrom: from,
    delTo: to,
    text,
    slice: allCode && !lines[first].whole && blockLines.length !== picked.length ? null : slice,
    partial: false,
    inTable: false,
    lines: picked,
    wholeDoc: from === 0 && to === doc.content.size,
  }
}

function deleteLineUnits(tr: Transaction, u: LineUnits): void {
  if (u.inTable) {
    for (const l of [...u.lines].reverse()) if (l.from < l.to) tr.delete(l.from, l.to)
    return
  }
  if (u.partial) {
    tr.delete(u.delFrom, u.delTo)
    return
  }
  if (u.wholeDoc) {
    tr.replaceWith(0, tr.doc.content.size, tr.doc.type.schema.nodes.paragraph.create())
    return
  }
  tr.deleteRange(u.delFrom, u.delTo)
}

function textObject(lines: Line[], cur: Cur, ch: string, around: boolean): CharRange | LineRange | null {
  if (ch === 'w' || ch === 'W') return wordObject(lines, cur, around, ch === 'W')
  if (ch === '"' || ch === "'" || ch === '`') return quoteObject(lines, cur, ch, around)
  if (ch === 'p') return paragraphObject(lines, cur.li, around)
  return bracketObject(lines, cur, ch, around)
}

/** Enter を押したのと同じ処理を通す(リスト・コード・見出しで、それぞれの動きになる) */
function pressEnter(view: EditorView): void {
  const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
  const handled = view.someProp('handleKeyDown', (f) => f(view, event))
  if (!handled) {
    const { state } = view
    view.dispatch(state.tr.split(state.selection.from).scrollIntoView())
  }
}

/** 「.」の繰り返しで、挿入モードで打った文字を入れ直す(改行は Enter として) */
function insertTyped(view: EditorView, text: string): void {
  const parts = text.split('\n')
  parts.forEach((part, i) => {
    if (i > 0) pressEnter(view)
    if (part) view.dispatch(view.state.tr.insertText(part.replace(new RegExp(OBJ, 'g'), '')))
  })
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

// ---- 描画 ----

function cursorDecorations(state: EditorState): DecorationSet | null {
  if (!commanding(state)) return null
  const s = vimState(state)
  const lines = linesOf(state.doc)
  if (lines.length === 0) return null
  const decos: Decoration[] = []
  const sel = state.selection
  const head = s.mode === 'normal' ? sel.head : s.head
  if (s.mode === 'normal' && !(sel instanceof TextSelection)) return null
  if (s.mode === 'visual' || s.mode === 'vline') {
    const a = Math.min(s.anchor, s.head)
    const b = Math.max(s.anchor, s.head)
    const la = lineIndexAt(lines, a)
    const lb = lineIndexAt(lines, b)
    if (s.mode === 'vline') {
      const seen = new Set<number>()
      for (let i = la; i <= lb; i++) {
        const l = lines[i]
        if (l.whole && !seen.has(l.blockPos)) {
          seen.add(l.blockPos)
          decos.push(Decoration.node(l.blockPos, l.blockPos + l.block.nodeSize, { class: 'vim-visual-line' }))
        } else if (!l.whole && l.from < l.to) decos.push(Decoration.inline(l.from, l.to, { class: 'vim-visual' }))
      }
    } else {
      const cb = curOf(lines, b)
      const end = lines[cb.li].from + (lines[cb.li].text.length === 0 ? 0 : nextGrapheme(lines[cb.li].text, cb.off))
      if (a < end) decos.push(Decoration.inline(a, end, { class: 'vim-visual' }))
      // 空の行も選んでいると分かるように
      for (let i = la; i <= lb; i++) if (lines[i].text.length === 0) decos.push(Decoration.widget(lines[i].from, emptyMark, { key: 'vim-empty', side: 1 }))
    }
  }
  const c = curOf(lines, head)
  const l = lines[c.li]
  const off = normalOff(l.text, c.off)
  const at = l.from + off
  if (l.text.length === 0) decos.push(Decoration.widget(at, eolCursor, { key: 'vim-eol', side: 1 }))
  else decos.push(Decoration.inline(at, l.from + nextGrapheme(l.text, off), { class: 'vim-cursor' }))
  return DecorationSet.create(state.doc, decos)
}

const eolCursor = () => {
  const span = document.createElement('span')
  span.className = 'vim-cursor vim-cursor-eol'
  span.textContent = '​'
  return span
}
const emptyMark = () => {
  const span = document.createElement('span')
  span.className = 'vim-visual vim-cursor-eol'
  span.textContent = '​'
  return span
}

/** 本文に Vim のキー操作を入れる */
export const vimPlugin = $prose(() => {
  const ctl = new VimController()
  return new Plugin<VimState>({
    key: vimKey,
    state: {
      init: (_config, state) => ({ mode: vimEnabled() ? 'normal' : 'insert', anchor: state.selection.head, head: state.selection.head, insertStart: null }),
      apply(tr, prev) {
        const meta = tr.getMeta(vimKey) as Meta | undefined
        let next: VimState = prev
        if (tr.docChanged) {
          next = {
            ...prev,
            anchor: tr.mapping.map(prev.anchor, -1),
            head: tr.mapping.map(prev.head, -1),
            insertStart: prev.insertStart === null ? null : tr.mapping.map(prev.insertStart, -1),
          }
        }
        if (meta) {
          const { vim: _v, ...rest } = meta
          if (Object.keys(rest).length > 0) next = { ...next, ...rest }
        }
        return next
      },
    },
    appendTransaction(trs, oldState, newState) {
      if (!vimEnabled()) return null
      const findClosed = trs.some((tr) => {
        const m = tr.getMeta(findPluginKey) as { query?: string } | undefined
        return m?.query === ''
      })
      if (findClosed) {
        const q = findPluginKey.getState(oldState)?.query
        if (q) ctl.lastSearch = q
      }
      const s = vimState(newState)
      if (s.mode === 'insert') return null
      const fromVim = trs.some((tr) => tr.getMeta(vimKey))
      const sel = newState.selection
      if (!(sel instanceof TextSelection)) return null
      const lines = linesOf(newState.doc)
      if (lines.length === 0) return null
      if (s.mode === 'visual' || s.mode === 'vline') {
        if (fromVim) return null
        if (sel.empty) {
          const p = clampNormal(lines, sel.head)
          return newState.tr.setSelection(TextSelection.create(newState.doc, p)).setMeta(vimKey, { vim: true, mode: 'normal' } satisfies Meta)
        }
        if (!trs.some((tr) => tr.selectionSet)) return null
        return newState.tr.setMeta(vimKey, { vim: true, ...visualFromSelection(lines, sel) } satisfies Meta)
      }
      if (fromVim && sel.empty) return null
      if (!sel.empty) {
        // マウスで選んだ・Shift+矢印で選んだ → ビジュアルモード。元に戻す・探す欄から戻ったなどは、選択の始まりにカーソル
        if (findClosed || fromVim || trs.some((tr) => tr.docChanged)) {
          return newState.tr.setSelection(TextSelection.create(newState.doc, clampNormal(lines, sel.from))).setMeta(vimKey, { vim: true })
        }
        return newState.tr.setMeta(vimKey, { vim: true, mode: 'visual', ...visualFromSelection(lines, sel) } satisfies Meta)
      }
      const p = clampNormal(lines, sel.head)
      if (p === sel.head) return null
      return newState.tr.setSelection(TextSelection.create(newState.doc, p)).setMeta(vimKey, { vim: true })
    },
    props: {
      attributes: (state): Record<string, string> => {
        if (!vimEnabled()) return {}
        return { class: `jot-vim vim-mode-${vimState(state).mode}`, tabindex: '0' }
      },
      decorations: cursorDecorations,
      handleDOMEvents: {
        keydown: (view, e) => ctl.keydown(view, e),
        focus: (view) => {
          ctl.view = view
          ctl.renderStatus()
          return false
        },
      },
    },
    view: (view) => {
      ctl.view = view
      const status = document.createElement('div')
      status.className = 'vim-status'
      status.hidden = true
      document.body.appendChild(status)
      ctl.status = status
      let lastEditable: string | null = null
      const sync = () => {
        const want = commanding(view.state) ? 'false' : 'true'
        if (view.dom.getAttribute('contenteditable') !== want) {
          const focused = view.hasFocus()
          view.dom.setAttribute('contenteditable', want)
          // 編集できる・できないが変わったことを、日本語入力にも知らせ直す(フォーカスを当て直す)
          if (focused && lastEditable !== null) {
            queueMicrotask(() => {
              if (!view.dom.isConnected) return
              view.dom.blur()
              if (want === 'true') view.focus()
              else view.dom.focus({ preventScroll: true })
            })
          }
        }
        lastEditable = want
        ctl.renderStatus()
      }
      sync()
      const off = onVimSetting(() => {
        ctl.pending = []
        view.dispatch(
          view.state.tr.setMeta(vimKey, { vim: true, mode: vimEnabled() ? 'normal' : 'insert', insertStart: null } satisfies Meta),
        )
        if (!vimEnabled()) view.dom.setAttribute('contenteditable', 'true')
        sync()
      })
      return {
        update: () => sync(),
        destroy: () => {
          off()
          status.remove()
          if (ctl.view === view) ctl.view = null
        },
      }
    },
  })
})

function visualFromSelection(lines: Line[], sel: Selection): { anchor: number; head: number } {
  const anchor = sel.anchor
  let head = sel.head
  if (head > anchor) {
    const c = curOf(lines, head)
    head = c.off > 0 ? lines[c.li].from + prevGrapheme(lines[c.li].text, c.off) : Math.max(anchor, head - 1)
  }
  return { anchor: clampNormal(lines, anchor), head: clampNormal(lines, head) }
}

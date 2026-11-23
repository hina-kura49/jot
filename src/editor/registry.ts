// いま表示しているエディタの保存の窓口。ストアはここを通して「保存し終える」を待つ(エディタとストアの循環参照を避ける)。

import type { EditorView } from '@milkdown/kit/prose/view'

export interface ActiveSession {
  /** 未保存の変更を今すぐ書き出し、書き終えるまで待つ。書き出す内容はこの呼び出しの時点で決まる */
  flush(): Promise<void>
  /** 未保存の変更があるか */
  isDirty(): boolean
  /** 表示しているページの path と、エディタが知っている最新の version */
  current(): { path: string; version: string } | null
  /** 自分の変更で上書きする: 保存の基準を、ディスクの最新の version にしてから保存する */
  overwriteWith(version: string): Promise<void>
  /**
   * 表示しているページの名前が変わった(改名・移動)。ディスクの内容が知っている内容と同じなら、文書を読み直さずに
   * path と version だけを差し替えて true を返す(入力位置も、改名を待つ間に打った文字もそのまま)。違えば false
   */
  rebind(oldPath: string, newPath: string, content: string, version: string): boolean
  /**
   * 表示しているページを動かし始める(見た目を先に動かすため)。path をすぐ newPath にし、終わりの合図を受けるまで保存を待たせる。
   * 合図に false を渡すと(動かせなかった)、path を oldPath に戻す。別のページなら null。
   * newPath を oldPath と同じにすると、path は変えずに保存だけを待たせる(名前を変える間)
   */
  beginMove(oldPath: string, newPath: string): ((ok: boolean) => void) | null
  /** 表示しているページ(path)のアイコンを変える(null は消す)。フロントマターを書き換えて保存する。別のページなら false */
  setIcon(path: string, icon: string | null): boolean
}

let active: ActiveSession | null = null

export const setActiveSession = (s: ActiveSession | null) => {
  active = s
}
export const activeSession = () => active

/** 未保存の変更を保存し終える(エディタがなければ何もしない) */
export const flushActive = () => active?.flush() ?? Promise.resolve()

// ---- タイトルと本文の行き来 ----

let focusEditorStart: (() => void) | null = null

/** エディタが「本文の先頭に入力位置を置く」処理を登録する */
export const setEditorStartFocuser = (fn: (() => void) | null) => {
  focusEditorStart = fn
}

/** 本文の先頭に入力位置を置く(タイトルで Enter / ↓ を押したとき) */
export const focusEditor = () => focusEditorStart?.()

let focusEditorEnd: (() => void) | null = null

/** エディタが「本文の末尾に入力位置を置く」処理を登録する */
export const setEditorEndFocuser = (fn: (() => void) | null) => {
  focusEditorEnd = fn
}

/** 本文の末尾に入力位置を置く(本文の下の空白をクリックしたとき) */
export const focusEditorAtEnd = () => focusEditorEnd?.()

// ---- 表示しているエディタ(ページの中を探す欄が使う) ----

let activeEditorView: EditorView | null = null

export const setActiveView = (view: EditorView | null) => {
  activeEditorView = view
}
/** 表示しているページのエディタ。なければ null */
export const activeView = () => activeEditorView

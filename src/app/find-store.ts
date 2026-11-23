import { create } from 'zustand'
import { closeFind, findState, findStep, setFindListener, setFindQuery } from '@/editor/find'
import { activeView } from '@/editor/registry'

// ページの中を探す欄(FindBar.tsx)の状態と操作。当たりの数と番号は、エディタの状態(find.ts)から写して持つ。

type FindStore = {
  open: boolean
  /** 開くたびに増やす(⌘F をもう一度押したときに、入力欄を選び直す合図) */
  seq: number
  query: string
  current: number
  total: number
}

export const useFind = create<FindStore>(() => ({ open: false, seq: 0, query: '', current: 0, total: 0 }))

/** エディタの当たりの数と番号を写す */
function sync(): void {
  const view = activeView()
  const { matches, current } = view ? findState(view) : { matches: [], current: 0 }
  useFind.setState({ current, total: matches.length })
}

// 文書の編集で当たりが変わったときも、数の表示を合わせる
setFindListener(() => {
  if (useFind.getState().open) sync()
})

export function search(query: string): void {
  useFind.setState({ query })
  const view = activeView()
  if (view) setFindQuery(view, query)
  sync()
}

/** 探す欄を開く(開いていれば、入力欄を選び直す)。本文で選んでいる語があれば、それを探す */
export function openFind(): void {
  const view = activeView()
  const sel = view?.state.selection
  const selected = view && sel && !sel.empty ? view.state.doc.textBetween(sel.from, sel.to, ' ') : ''
  useFind.setState((s) => ({ open: true, seq: s.seq + 1 }))
  search(selected && !selected.includes('\n') && selected.length <= 100 ? selected : useFind.getState().query)
}

/** 次(1)・前(-1)の当たりへ。探す欄が閉じていれば何もしない */
export function findAgain(dir: 1 | -1): void {
  const view = activeView()
  if (!useFind.getState().open || !view) return
  findStep(view, dir)
  sync()
}

/** 閉じる。select なら、いまの当たりを選んだ状態で本文に戻る */
export function hideFind(select: boolean): void {
  if (!useFind.getState().open) return
  useFind.setState({ open: false })
  const view = activeView()
  if (view) closeFind(view, select)
}

// Vim のキー操作を使うかどうか。この端末だけで覚えておく(localStorage)。既定は使わない。

const STORAGE_KEY = 'jot.vim'

let enabled = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
})()

const listeners = new Set<() => void>()

export const vimEnabled = () => enabled

export function setVimEnabled(on: boolean): void {
  if (on === enabled) return
  enabled = on
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    // 覚えられなくても、今の間は切り替わる
  }
  for (const fn of listeners) fn()
}

export const toggleVim = () => setVimEnabled(!enabled)

export function onVimSetting(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

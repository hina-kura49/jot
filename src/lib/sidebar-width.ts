// サイドバーの幅。右端のつまみをドラッグして変えられる。値は CSS の --sidebar-width に入れ、
// 本文の左の余白(PageView)もこの変数を使うので、一緒に動く。幅はこの端末だけで覚えておく(localStorage)。

export const SIDEBAR_DEFAULT = 240
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
const STORAGE_KEY = 'jot.sidebarWidth'

export const clampSidebarWidth = (px: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)))

/** 幅を画面に当てる。save なら次回の起動のために覚えておく */
export function applySidebarWidth(px: number, save = false): number {
  const width = clampSidebarWidth(px)
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  if (save) {
    try {
      localStorage.setItem(STORAGE_KEY, String(width))
    } catch {
      // 覚えておけなくても、いまの幅はそのまま使える
    }
  }
  return width
}

/** 前回の幅に戻す(起動時に1度呼ぶ) */
export function restoreSidebarWidth(): void {
  let saved: number | null = null
  try {
    saved = Number(localStorage.getItem(STORAGE_KEY)) || null
  } catch {
    // 読めなければ既定の幅
  }
  if (saved !== null) applySidebarWidth(saved)
}

// ページを PDF に書き出す。macOS の印刷ダイアログを開き、左下の「PDF」から保存してもらう。
// アプリ(WKWebView)では window.print() が何もしないので、Rust のコマンド(src-tauri/src/print.rs)で開く。
// 紙の余白もそちらで決める。見た目は index.css の @media print で整える。
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'

/** 印刷ダイアログを開く。title は保存するファイル名の候補になる */
export async function printPage(title: string): Promise<void> {
  if (isTauri) {
    await invoke('print_page', { title })
    return
  }
  // ブラウザ(開発中)では、文書の題がファイル名の候補になる
  const before = document.title
  document.title = title
  window.addEventListener('afterprint', () => (document.title = before), { once: true })
  window.print()
}

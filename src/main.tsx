import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { CaptureWindow } from './capture/CaptureWindow'
import { isCaptureWindow } from './lib/platform'
import { restoreSidebarWidth } from './lib/sidebar-width'
import 'prosemirror-view/style/prosemirror.css'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root がありません')
// クイックキャプチャのウィンドウは背景を透かし、角の丸いパネルだけを見せる
if (isCaptureWindow()) document.documentElement.dataset.window = 'capture'
else restoreSidebarWidth()

// 本文の外にファイルを落としても、そのファイルをウィンドウで開いてしまわないようにする(本文へのファイルのドロップは file-paste.ts)
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault())
window.addEventListener('drop', (e) => hasFiles(e) && e.preventDefault())

// 合字のフォント(同梱)を読み終えてから描く。描いた後に文字の幅が変わって本文がずれないように。
// 読めなくても(長くても 300ms で)そのまま描く
const fonts = Promise.all([document.fonts.load('16px "Jot Symbols"', '->'), document.fonts.load('16px "JetBrains Mono"', '->')])
void Promise.race([fonts, new Promise((r) => setTimeout(r, 300))])
  .catch(() => {})
  .finally(() =>
    createRoot(root).render(
      <StrictMode>
        {isCaptureWindow() ? <CaptureWindow /> : <App />}
      </StrictMode>,
    ),
  )

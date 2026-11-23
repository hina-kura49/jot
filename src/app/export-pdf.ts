import { flushActive } from '@/editor/registry'
import { printPage } from '@/lib/print'
import { titleOf, useApp } from '@/store/app'

/** ページを PDF に書き出す(印刷ダイアログを開く)。先に保存を済ませる */
export async function exportPdf(title: string) {
  await flushActive()
  try {
    await printPage(title || '無題')
  } catch (e) {
    console.warn('[print]', e)
    useApp.getState().showNotice({ tone: 'warning', title: 'PDF に書き出せませんでした', body: '印刷ダイアログを開けませんでした。もう一度お試しください。', actions: [] })
  }
}

/** 開いているページ(あれば)を PDF に書き出す。コマンドパレットとショートカットから使う */
export function exportOpenPage() {
  const { page, tree } = useApp.getState()
  if (!page || page.unreadable) return
  // パレットが閉じて画面から消えてから、ダイアログを開く
  setTimeout(() => void exportPdf(titleOf(tree, page.path) ?? ''), 0)
}

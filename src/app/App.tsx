import { useEffect } from 'react'
import { loadCodeLanguages } from '@/editor/plugins'
import { backend } from '@/backend'
import { activeSession, flushActive } from '@/editor/registry'
import { useShortcut } from '@/lib/keyboard'
import { captureShortcutFailed, onOpenVaultRequested, watchAppLifecycle } from '@/lib/platform'
import { useApp } from '@/store/app'
import { activeView } from '@/editor/registry'
import { CommandPalette } from './CommandPalette'
import { findAgain, openFind } from './find-store'
import { FirstLaunch } from './FirstLaunch'
import { openPalette, togglePalette } from './palette-store'
import { exportOpenPageHtml } from './export-html'
import { exportOpenPage } from './export-pdf'
import { PageView } from './PageView'
import { Sidebar } from './Sidebar'

/** 起動して落ち着いたら、コードの色付けの言語を読み込んでおく(次に開くページの最初の描画から色が付く) */
const PRELOAD_LANGUAGES_AFTER_MS = 3000

export function App() {
  const status = useApp((s) => s.status)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const init = useApp((s) => s.init)
  const toggleSidebar = useApp((s) => s.toggleSidebar)

  const handleExternalChange = useApp((s) => s.handleExternalChange)

  useEffect(() => {
    void init()
  }, [init])

  // 隠す・終了する・後ろに回る前に、未保存の変更を保存する
  useEffect(() => watchAppLifecycle({ save: flushActive, hasUnsaved: () => activeSession()?.isDirty() ?? false }), [])

  // メニューの「保管庫を開く…」
  useEffect(() => onOpenVaultRequested(() => useApp.getState().openVault()), [])

  // クイックキャプチャのホットキーを登録できなかったら知らせる(アプリはそのまま使える)
  useEffect(() => {
    void captureShortcutFailed()
      .then((failed) => failed && useApp.getState().warnCaptureShortcut())
      .catch(() => {})
  }, [])

  // 他のアプリでの変更: ツリーを取り直し、開いているページの version を比べる
  useEffect(() => backend().onExternalChange(() => void handleExternalChange()), [handleExternalChange])

  // 起動して落ち着いたら、コードの色付けの言語を読み込んでおく
  useEffect(() => {
    if (status !== 'ready') return
    const id = setTimeout(() => void loadCodeLanguages(), PRELOAD_LANGUAGES_AFTER_MS)
    return () => clearTimeout(id)
  }, [status])

  const newPage = useApp((s) => s.newPage)
  useShortcut({ key: '\\', mod: true }, toggleSidebar)
  // 新規ページ(開いているページと同じフォルダ) / 子ページ
  useShortcut({ key: 'n', mod: true }, () => void newPage('sibling'), status === 'ready')
  useShortcut({ key: 'n', mod: true, shift: true }, () => void newPage('child'), status === 'ready')
  // コマンドパレット。⌘P(ページへ移動)も同じパレットを開く
  useShortcut({ key: 'k', mod: true }, togglePalette, status === 'ready')
  useShortcut({ key: 'p', mod: true }, openPalette, status === 'ready')
  // ⌘F: ページを開いていればページの中を探す。開いていなければ保管庫全体を探す(パレット)
  useShortcut({ key: 'f', mod: true }, () => (activeView() ? openFind() : openPalette()), status === 'ready')
  useShortcut({ key: 'g', mod: true }, () => findAgain(1), status === 'ready')
  useShortcut({ key: 'g', mod: true, shift: true }, () => findAgain(-1), status === 'ready')
  useShortcut({ key: 'e', mod: true, shift: true }, exportOpenPage, status === 'ready')
  useShortcut({ key: 'h', mod: true, shift: true }, exportOpenPageHtml, status === 'ready')

  if (status === 'loading') return null
  if (status === 'no-vault') return <FirstLaunch />

  return (
    <div className="relative flex h-full overflow-hidden">
      <Sidebar collapsed={sidebarCollapsed} />
      <PageView />
      <CommandPalette />
    </div>
  )
}

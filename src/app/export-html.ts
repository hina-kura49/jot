import { invoke } from '@tauri-apps/api/core'
import { flushActive } from '@/editor/registry'
import { isTauri } from '@/lib/platform'
import { titleOf, useApp } from '@/store/app'

// ページを HTML 1枚に書き出す(共有用)。受け取った人がブラウザで開くだけで、Jot と同じ見た目で読める。
// - 中身は、いま画面に描いている本文をそのまま写す(Markdown を別の方法で HTML にしないので、見た目が食い違わない)
// - 画像とフォントは data: URL にして詰め込む。外のファイルを指さないので、1ファイルだけ送ればよい
// - 見た目はアプリの CSS をそのまま入れる。OS の暗い表示にも合わせて切り替わる
// - 保管庫のほかのページへのリンクは、受け取った人には開けないので、文字だけにする

/** 書き出しに入れない、編集のための部品 */
const EDITOR_ONLY = ['.drag-handle', '.page-icon-add', '[role=dialog]', '.ProseMirror-gapcursor', '.ProseMirror-separator', '.ProseMirror-trailingBreak']
/** 編集のための属性 */
const EDITOR_ATTRS = ['contenteditable', 'spellcheck', 'autocapitalize', 'autocorrect', 'translate', 'draggable', 'tabindex', 'role', 'aria-label']

/** URL を data: URL にする。読めなければ null(元の URL のまま残す) */
async function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** アプリの CSS をすべて集め、中の url(...)(フォントなど)を data: URL にする */
async function collectCss(): Promise<string> {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 別の場所の CSS は読めない(使っていない)
    }
    const base = sheet.href ?? document.baseURI
    let css = Array.from(rules, (r) => r.cssText).join('\n')
    const urls = new Set(Array.from(css.matchAll(/url\(["']?([^"')]+)["']?\)/g), (m) => m[1]).filter((u) => !u.startsWith('data:')))
    for (const url of urls) {
      const data = await toDataUrl(new URL(url, base).href)
      if (data) css = css.split(url).join(data)
    }
    parts.push(css)
  }
  return parts.join('\n')
}

/** 書き出し用に、本文の写しを整える */
async function cleanClone(article: HTMLElement): Promise<HTMLElement> {
  const clone = article.cloneNode(true) as HTMLElement
  clone.removeAttribute('style')
  clone.querySelectorAll(EDITOR_ONLY.join(',')).forEach((el) => el.remove())
  clone.querySelectorAll('.page-icon').forEach((el) => el.classList.remove('no-print'))
  // Mermaid の図は、原文を閉じて図だけにする
  clone.querySelectorAll('.mermaid-editing').forEach((el) => el.classList.remove('mermaid-editing'))
  for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]) {
    for (const attr of EDITOR_ATTRS) el.removeAttribute(attr)
  }
  // エディタは描き終えるまで隠しているので、見えるようにする
  clone.querySelectorAll<HTMLElement>('.jot-editor').forEach((el) => (el.style.visibility = ''))
  // チェックボックスは見るだけ
  clone.querySelectorAll('input').forEach((el) => el.setAttribute('disabled', ''))
  // リンク: Web のものは新しいタブで開き、保管庫の中を指すものは文字だけにする
  clone.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener')
    } else if (!href.startsWith('#')) {
      a.removeAttribute('href')
    }
  })
  // 画像を詰め込む
  await Promise.all(
    Array.from(clone.querySelectorAll('img'), async (img) => {
      const src = img.getAttribute('src')
      const data = src && (await toDataUrl(new URL(src, document.baseURI).href))
      if (data) img.setAttribute('src', data)
      img.removeAttribute('srcset')
      img.setAttribute('loading', 'lazy')
    }),
  )
  return clone
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** HTML 1枚の中身を作る */
export async function buildPageHtml(article: HTMLElement, title: string): Promise<string> {
  const [css, body] = await Promise.all([collectCss(), cleanClone(article)])
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Jot">
<title>${escapeHtml(title)}</title>
<style>
${css}
/* 書き出し用: 本文だけを、画面いっぱいの紙に置く */
html, body { height: auto; overflow: auto; }
body { margin: 0; background: var(--panel); }
.page { padding-bottom: var(--space-6); }
.page-icon-emoji { cursor: default; }
.page-icon-emoji:hover { background: none; }
@media (max-width: 640px) { .page { padding: var(--space-5) var(--space-4); } }
</style>
</head>
<body>
${body.outerHTML}
</body>
</html>
`
}

/** ファイル名に使えない文字を置き換える */
const fileNameOf = (title: string) => `${(title || '無題').replace(/[/\\:*?"<>|]/g, '-').trim()}.html`

/** 開いているページを HTML に書き出す。先に保存を済ませる */
export async function exportHtml(): Promise<void> {
  const { page, tree, showNotice } = useApp.getState()
  const article = document.querySelector<HTMLElement>('article.page')
  if (!page || page.unreadable || !article) return
  const title = titleOf(tree, page.path) ?? ''
  await flushActive()
  try {
    const html = await buildPageHtml(article, title || '無題')
    if (isTauri) {
      const saved = await invoke<string | null>('save_html', { fileName: fileNameOf(title), html })
      if (saved) showNotice({ tone: 'info', title: 'HTML に書き出しました', body: `${saved} に保存しました。ブラウザで開けば、そのまま読めます。`, actions: [] })
    } else {
      // ブラウザ(開発中)では、ダウンロードにする
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: fileNameOf(title) })
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  } catch (e) {
    console.warn('[export-html]', e)
    showNotice({ tone: 'warning', title: 'HTML に書き出せませんでした', body: 'もう一度お試しください。', actions: [] })
  }
}

/** パレットとショートカットから使う。パレットが閉じてから書き出す */
export const exportOpenPageHtml = () => setTimeout(() => void exportHtml(), 0)

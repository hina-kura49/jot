import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'

// コードブロックの見た目(Wryte と同じ「窓」の形)。
// 上の帯に、3つの丸・言語・コピーのボタンを置き、その下にコードを書く。
// 言語は帯の欄で書き換えられる(``` のあとに書く言語と同じもの。Markdown にはそのまま保存される)。

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

/** コピーできたことを見せておく長さ */
const COPIED_MS = 1800

/** 言語の欄に書いた文字を、``` のあとに書ける形にそろえる(空白で切れるので、最初の語だけを使う) */
export const normalizeLanguage = (text: string): string => text.trim().split(/\s+/)[0] ?? ''

export function codeWindowView(initial: PMNode, view: EditorView, getPos: () => number | undefined, keep: (next: PMNode) => boolean): NodeView {
  const dom = document.createElement('div')
  dom.className = 'code-block'

  const header = document.createElement('div')
  header.className = 'code-header'
  header.contentEditable = 'false'

  const dots = document.createElement('span')
  dots.className = 'window-dots'
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))

  const language = document.createElement('input')
  language.className = 'code-language'
  language.type = 'text'
  language.placeholder = 'plaintext'
  language.spellcheck = false
  language.autocapitalize = 'off'
  language.setAttribute('autocorrect', 'off')
  language.setAttribute('aria-label', 'コードの言語')

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'code-copy'
  copy.title = 'コピー'
  copy.setAttribute('aria-label', 'コードをコピー')
  copy.innerHTML = COPY_ICON

  header.append(dots, language, copy)

  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.append(code)
  dom.append(header, pre)

  let current = initial
  const show = (node: PMNode) => {
    current = node
    const value = String(node.attrs.language ?? '')
    if (value) pre.dataset.language = value
    else delete pre.dataset.language
    if (document.activeElement !== language) language.value = value
  }
  show(initial)

  const commit = () => {
    const value = normalizeLanguage(language.value)
    language.value = value
    const pos = getPos()
    if (pos === undefined || value === String(current.attrs.language ?? '')) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: value }))
  }
  /** 入力位置をコードの先頭に戻す */
  const backToCode = () => {
    const pos = getPos()
    if (pos !== undefined) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
    view.focus()
  }
  language.addEventListener('change', commit)
  language.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      backToCode()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      language.value = String(current.attrs.language ?? '')
      backToCode()
    }
  })

  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(current.textContent).then(
      () => {
        copy.innerHTML = CHECK_ICON
        copy.dataset.copied = ''
        clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          copy.innerHTML = COPY_ICON
          delete copy.dataset.copied
        }, COPIED_MS)
      },
      () => undefined,
    )
  })
  // 帯の何もないところを押しても、本文の入力位置を動かさない
  header.addEventListener('mousedown', (e) => {
    if (e.target !== language) e.preventDefault()
  })

  return {
    dom,
    contentDOM: code,
    update: (next) => {
      if (next.type !== initial.type || !keep(next)) return false
      show(next)
      return true
    },
    // 帯の中身と属性は自分で書き換えたもの
    ignoreMutation: (m) => header.contains(m.target) || (m.type === 'attributes' && (m.target === dom || m.target === pre)),
    stopEvent: (e) => header.contains(e.target as Node),
    destroy: () => clearTimeout(copiedTimer),
  }
}

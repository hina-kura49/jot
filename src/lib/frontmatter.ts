// ページのアイコンを、Markdown の先頭のフロントマター(`---` で挟んだ設定欄)の `icon:` に読み書きする。
// ほかの行は1文字も変えない。読み方は core(index.rs の icon_of)と同じ。

const OPEN = /^(﻿?)---[ \t]*(\r?\n)/
const ICON_LINE = /^icon:.*$/m

/** フロントマターの範囲。無ければ null。body は閉じの `---` 行の後ろから */
function locate(markdown: string): { bom: string; newline: string; inner: string; rest: string } | null {
  const open = OPEN.exec(markdown)
  if (!open) return null
  const after = markdown.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(after)
  if (!close) return null
  return { bom: open[1], newline: open[2], inner: after.slice(0, close.index), rest: after.slice(close.index + close[0].length) }
}

/** `icon:` の値。無ければ null */
export function readIcon(markdown: string): string | null {
  const fm = locate(markdown)
  const line = fm && ICON_LINE.exec(fm.inner)
  if (!line) return null
  let value = line[0].slice('icon:'.length).trim()
  for (const q of ['"', "'"]) if (value.length >= 2 && value.startsWith(q) && value.endsWith(q)) value = value.slice(1, -1).trim()
  return value || null
}

/**
 * `icon:` を icon にした Markdown を返す。null なら `icon:` の行を消す(ほかに何もなければフロントマターごと消す)。
 * フロントマターが無ければ、先頭に作る
 */
export function writeIcon(markdown: string, icon: string | null): string {
  const fm = locate(markdown)
  if (!fm) {
    if (icon === null) return markdown
    const bom = markdown.startsWith('﻿') ? '﻿' : ''
    const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
    return `${bom}---${newline}icon: ${icon}${newline}---${newline}${markdown.slice(bom.length)}`
  }
  const { bom, newline, rest } = fm
  let inner = fm.inner
  if (icon === null) {
    inner = inner.replace(/^icon:.*(?:\r?\n|$)/m, '')
    if (inner.trim() === '') return bom + rest
  } else if (ICON_LINE.test(inner)) {
    inner = inner.replace(ICON_LINE, () => `icon: ${icon}`)
  } else {
    inner = `icon: ${icon}${newline}${inner}`
  }
  return `${bom}---${newline}${inner}---${newline}${rest}`
}

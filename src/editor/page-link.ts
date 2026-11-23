import { $prose } from '@milkdown/kit/utils'
import type { Schema, Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { PageMeta } from '@/backend'
import { dirOf, encodeLinkDestination, hasScheme, relativePath, resolveInVault } from '@/lib/paths'
import { useApp } from '@/store/app'
import { currentImagePagePath } from './plugins'

/**
 * /page が挿入するリンクの行き先。バックエンドの改名処理と一致させる必要がある。
 * - いま開いているページのあるフォルダから見た相対パス
 * - 空白 ( ) < > # % ? と制御文字だけをパーセントエンコード(16進数は大文字)。日本語などはそのまま。<...> で囲まない
 */
export const pageLinkDestination = (currentPagePath: string, targetPath: string): string =>
  encodeLinkDestination(relativePath(dirOf(currentPagePath), targetPath))

/** 表示文字列は createPage が返した title と完全に同じにする */
export function pageLinkNode(schema: Schema, currentPagePath: string, target: PageMeta): PMNode {
  const link = schema.marks.link.create({ href: pageLinkDestination(currentPagePath, target.path), title: null })
  return schema.text(target.title, [link])
}

/** カーソルの位置(選択範囲があれば置き換え)にページへのリンクを入れる */
export function insertPageLink(view: EditorView, currentPagePath: string, target: PageMeta): void {
  const node = pageLinkNode(view.state.schema, currentPagePath, target)
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView())
}

/**
 * ページへのリンクの行き先を、開くページのパスにする。ページへのリンクでなければ、または保管庫の外なら null。
 * 見出しへの指定(#...)は外す。
 */
export function pagePathFromHref(currentPagePath: string, href: string): string | null {
  if (href === '' || hasScheme(href) || href.startsWith('#')) return null
  const dest = href.split('#')[0]
  if (!/\.md$/i.test(dest)) return null
  let decoded = dest
  try {
    decoded = decodeURIComponent(dest)
  } catch {
    // エンコードが壊れているときは、書かれたままの名前で探す
  }
  return resolveInVault(dirOf(currentPagePath), decoded)
}

/** ページへのリンクを押したら、そのページを開く(Shift で範囲を選ぶときは開かない) */
export const pageLinks = $prose(
  () =>
    new Plugin({
      props: {
        handleClick: (_view, _pos, event) => {
          if (event.button !== 0 || event.shiftKey) return false
          const anchor = event.target instanceof Element ? event.target.closest('a') : null
          const path = anchor && pagePathFromHref(currentImagePagePath(), anchor.getAttribute('href') ?? '')
          if (!path) return false
          event.preventDefault()
          void useApp.getState().openPage(path)
          return true
        },
      },
    }),
)

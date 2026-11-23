import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import type { Blockquote, Nodes, Paragraph, PhrasingContent, Root, RootContent } from 'mdast'
import { visit } from 'unist-util-visit'

// ---- コールアウトとトグル ----
// Obsidian のコールアウトの書き方で保存する。Obsidian でもそのまま表示できる。
//   コールアウト:  > [!note] タイトル        (タイトルは省略できる)
//                  > 本文
//   トグル:        > [!note]- タイトル       (折りたためるコールアウト。- は閉じた状態、+ は開いた状態で表示)
//                  > 中身
//   トグル見出し:  > [!note|h2]- タイトル    (| の後ろは Obsidian の「メタデータ」。h1〜h3 で見出しの大きさにする)
// エディタの中では、callout(入れ物)の最初の子が callout_title(タイトルの行)、2つ目から後ろが本文のブロック。
// トグルの開閉はエディタの中だけの状態で、ファイルには書かない(開閉のたびにファイルが変わらないように)。
// 読み込んだときは、元の印(- / +)に従って閉じた状態・開いた状態で表示する。

/** 記号の並び `[!種類|メタデータ]折りたたみ` */
const MARKER = /^\[!([^\]|\s]+)(?:\|([^\]\n]*))?\]([+-]?)(?:[ \t]+|(?=\n)|$)/

type CalloutNode = { type: 'callout'; kind: string; meta: string; fold: string; children: RootContent[] }
type CalloutTitleNode = { type: 'calloutTitle'; children: PhrasingContent[] }

/** 段落の行内の要素を、最初の改行で「タイトルの行」と「残り」に分ける */
function splitFirstLine(inline: PhrasingContent[]): { title: PhrasingContent[]; rest: PhrasingContent[] } {
  const title: PhrasingContent[] = []
  const rest: PhrasingContent[] = []
  let split = false
  for (const node of inline) {
    if (split) rest.push(node)
    else if (node.type === 'text' && !node.value) continue
    else if (node.type === 'break') split = true
    else if (node.type === 'text' && node.value.includes('\n')) {
      const at = node.value.indexOf('\n')
      const before = node.value.slice(0, at)
      const after = node.value.slice(at + 1)
      if (before) title.push({ ...node, value: before })
      if (after) rest.push({ type: 'text', value: after })
      split = true
    } else title.push(node)
  }
  for (let i = title.length - 1; i >= 0; i--) {
    const node = title[i]
    if (node.type === 'text' && !node.value) title.splice(i, 1)
  }
  const last = title.at(-1)
  if (last?.type === 'text') {
    last.value = last.value.replace(/[ \t]+$/, '')
    if (!last.value) title.pop()
  }
  return { title, rest }
}

/** 引用のうち、先頭が `[!種類]` のものをコールアウトにする */
export const calloutSyntax = $remark('calloutSyntax', () => () => (tree: Root, file) => {
  const source = String(file.value ?? '')
  visit(tree, 'blockquote', (node: Blockquote, index, parent) => {
    if (!parent || index === undefined) return
    const first = node.children[0]
    if (first?.type !== 'paragraph') return
    const head = first.children[0]
    if (head?.type !== 'text') return
    const m = MARKER.exec(head.value)
    if (!m) return
    // `\[!note]` のように打ち消した書き方は、ただの文字のまま
    const offset = first.position?.start.offset
    if (source && offset !== undefined && source[offset] !== '[') return
    const inline: PhrasingContent[] = [{ ...head, value: head.value.slice(m[0].length) }, ...first.children.slice(1)]
    const { title, rest } = splitFirstLine(inline)
    const body: RootContent[] = rest.length > 0 ? [{ type: 'paragraph', children: rest } satisfies Paragraph] : []
    // 子の配列はそのまま使い回す(この後、中の引用(入れ子のコールアウト)を同じ配列の中で置き換えるため)
    const children = node.children as RootContent[]
    children.splice(0, 1, { type: 'calloutTitle', children: title } satisfies CalloutTitleNode as unknown as RootContent, ...body)
    const callout: CalloutNode = { type: 'callout', kind: m[1], meta: m[2] ?? '', fold: m[3], children }
    ;(parent.children as unknown[])[index] = callout
  })
})

/** トグル見出しの大きさ(メタデータが h1〜h3 のとき) */
export const headingLevelOf = (meta: string): number | null => {
  const m = /^h([1-3])$/i.exec(meta.trim())
  return m ? Number(m[1]) : null
}

export const calloutSchema = $nodeSchema('callout', () => ({
  content: 'callout_title block+',
  group: 'block',
  defining: true,
  attrs: {
    kind: { default: 'note', validate: 'string' },
    meta: { default: '', validate: 'string' },
    fold: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      tag: 'div[data-callout]',
      getAttrs: (dom) => ({
        kind: dom.getAttribute('data-callout') || 'note',
        meta: dom.getAttribute('data-meta') ?? '',
        fold: dom.getAttribute('data-fold') ?? '',
      }),
    },
  ],
  toDOM: (node) => {
    const level = headingLevelOf(String(node.attrs.meta))
    const attrs: Record<string, string> = {
      class: 'callout',
      'data-callout': String(node.attrs.kind),
      'data-meta': String(node.attrs.meta),
      'data-fold': String(node.attrs.fold),
    }
    if (node.attrs.fold) attrs['data-toggle'] = ''
    if (level !== null) attrs['data-heading'] = String(level)
    return ['div', attrs, 0]
  },
  parseMarkdown: {
    match: (node) => node.type === 'callout',
    runner: (state, node, type) => {
      const n = node as unknown as CalloutNode
      state.openNode(type, { kind: n.kind, meta: n.meta, fold: n.fold }).next(node.children).closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      const title = node.firstChild
      const { kind, meta, fold } = node.attrs as { kind: string; meta: string; fold: string }
      const marker = `[!${kind}${meta ? `|${meta}` : ''}]${fold}`
      const hasTitle = (title?.content.size ?? 0) > 0
      state.openNode('blockquote')
      state.openNode('paragraph', undefined, { data: { calloutTitle: true } })
      state.addNode('html', undefined, hasTitle ? `${marker} ` : marker)
      if (title && hasTitle) state.next(title.content)
      state.closeNode()
      const body = node.content.cut(title?.nodeSize ?? 0)
      // 本文が空の段落1つだけなら書かない(`>` だけの行を残さない)
      const empty = body.childCount === 1 && body.firstChild?.type.name === 'paragraph' && body.firstChild.content.size === 0
      if (!empty) state.next(body)
      state.closeNode()
    },
  },
}))

export const calloutTitleSchema = $nodeSchema('callout_title', () => ({
  content: 'inline*',
  defining: true,
  parseDOM: [{ tag: 'div[data-callout-title]' }],
  toDOM: () => ['div', { class: 'callout-title', 'data-callout-title': '' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'calloutTitle',
    runner: (state, node, type) => {
      state.openNode(type).next(node.children).closeNode()
    },
  },
  toMarkdown: {
    // callout の書き出しが受け持つので、ここには来ない
    match: (node) => node.type.name === 'callout_title',
    runner: (state, node) => {
      state.next(node.content)
    },
  },
}))

/**
 * 書き出しのつなぎ方。タイトルの行の直後は、空行(`>` だけの行)をはさまずに続ける(Obsidian で書いたときと同じ形)。
 * 続けてよいのは、段落の続きの行として読んでも元に戻る(読み込むときに1行目で切り分ける)か、段落を途中で終わらせられるブロックだけ。
 * (段落の先頭の `===` などは、書き出しのときに `\===` と打ち消されるので、見出しの下線とは読まれない)
 */
export function calloutJoin(left: Nodes, right: Nodes, parent: Nodes): number | undefined {
  if (parent.type !== 'blockquote' || left.type !== 'paragraph') return undefined
  if (!(left.data as { calloutTitle?: boolean } | undefined)?.calloutTitle) return undefined
  switch (right.type) {
    case 'paragraph':
    case 'blockquote':
    case 'heading':
      return 0
    case 'list':
      // 番号付きリストは 1 から始まるときだけ、段落を途中で終わらせられる
      return !right.ordered || right.start == null || right.start === 1 ? 0 : undefined
    default:
      return undefined
  }
}

// ---- エディタの中での動き ----

type FoldState = { closed: DecorationSet; placeholders: DecorationSet }
type FoldMeta = { toggle: number }

export const foldKey = new PluginKey<FoldState>('jot-callout-fold')

const isToggle = (node: PMNode) => node.type.name === 'callout' && Boolean(node.attrs.fold)

const closedDecoration = (pos: number, node: PMNode) => Decoration.node(pos, pos + node.nodeSize, { 'data-open': 'false' }, { closed: true })

/** 読み込んだときに閉じて表示するトグル(印が - のもの) */
function initialClosed(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (isToggle(node) && node.attrs.fold === '-') decorations.push(closedDecoration(pos, node))
  })
  return DecorationSet.create(doc, decorations)
}

/** 空のタイトルの行に、薄い案内を出す */
function placeholders(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'callout') return true
    const title = node.firstChild
    if (title && title.content.size === 0) {
      const text = isToggle(node) ? 'トグル' : String(node.attrs.kind)
      decorations.push(Decoration.node(pos + 1, pos + 1 + title.nodeSize, { class: 'is-empty', 'data-placeholder': text }))
    }
    return true
  })
  return DecorationSet.create(doc, decorations)
}

const closedAt = (set: DecorationSet, pos: number) => set.find(pos, pos + 1, (spec: { closed?: boolean }) => spec.closed === true).find((d) => d.from === pos)

/** カーソルが閉じたトグルの中身に入ったら、そのトグルを開く(隠れた所にカーソルを置かない) */
function openAroundSelection(set: DecorationSet, state: EditorState): DecorationSet {
  let next = set
  for (const $pos of [state.selection.$from, state.selection.$to]) {
    for (let d = $pos.depth; d > 0; d--) {
      if (!isToggle($pos.node(d)) || $pos.index(d) === 0) continue
      const found = closedAt(next, $pos.before(d))
      if (found) next = next.remove([found])
    }
  }
  return next
}

export const calloutFold = $prose(
  () =>
    new Plugin<FoldState>({
      key: foldKey,
      state: {
        init: (_, { doc }) => ({ closed: initialClosed(doc), placeholders: placeholders(doc) }),
        apply: (tr: Transaction, prev, _old, state) => {
          let closed = prev.closed.map(tr.mapping, tr.doc)
          const meta = tr.getMeta(foldKey) as FoldMeta | undefined
          if (meta) {
            const found = closedAt(closed, meta.toggle)
            const node = tr.doc.nodeAt(meta.toggle)
            if (found) closed = closed.remove([found])
            else if (node && isToggle(node)) closed = closed.add(tr.doc, [closedDecoration(meta.toggle, node)])
          }
          if (tr.selectionSet || tr.docChanged) closed = openAroundSelection(closed, state)
          return { closed, placeholders: tr.docChanged ? placeholders(tr.doc) : prev.placeholders }
        },
      },
      props: {
        decorations: (state) => {
          const s = foldKey.getState(state)
          if (!s) return null
          return s.closed.add(state.doc, s.placeholders.find())
        },
        handleDOMEvents: {
          // タイトルの行の左の三角を押したら開閉する
          mousedown: (view, event) => {
            const target = event.target
            if (!(target instanceof HTMLElement) || event.button !== 0) return false
            const title = target.closest<HTMLElement>('.callout[data-toggle] > .callout-title')
            if (!title) return false
            const r = title.getBoundingClientRect()
            const width = Number.parseFloat(getComputedStyle(title).paddingLeft) || 24
            if (event.clientX - r.left > width) return false
            const pos = view.posAtDOM(title, 0) - 2
            const node = view.state.doc.nodeAt(pos)
            if (!node || !isToggle(node)) return false
            event.preventDefault()
            toggleFold(view, pos)
            return true
          },
        },
      },
    }),
)

/** トグルが閉じているか */
export const isClosed = (state: EditorState, pos: number) => {
  const s = foldKey.getState(state)
  return s ? closedAt(s.closed, pos) !== undefined : false
}

/** pos のトグルを開閉する。閉じるときに中身にカーソルがあれば、タイトルの行の末尾へ移す */
export function toggleFold(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node || !isToggle(node)) return
  const tr = view.state.tr.setMeta(foldKey, { toggle: pos } satisfies FoldMeta)
  const bodyStart = pos + 1 + (node.firstChild?.nodeSize ?? 0)
  const { from, to } = view.state.selection
  const closing = !isClosed(view.state, pos)
  if (closing && to > bodyStart && from < pos + node.nodeSize) {
    tr.setSelection(TextSelection.create(tr.doc, bodyStart - 1))
  }
  view.dispatch(tr)
}

/** カーソルのあるタイトルの行(callout_title)と、その callout の位置 */
function titleAt(state: EditorState): { calloutPos: number; callout: PMNode } | null {
  const { $from } = state.selection
  if ($from.parent.type.name !== 'callout_title' || $from.depth < 2) return null
  return { calloutPos: $from.before($from.depth - 1), callout: $from.node($from.depth - 1) }
}

export const calloutKeys = $prose(() =>
  keymap({
    // タイトルの行の先頭で Backspace: コールアウト・トグルをやめて、タイトルと中身を普通のブロックに戻す(Notion と同じ)
    Backspace: (state, dispatch) => {
      const { selection } = state
      const at = titleAt(state)
      if (!at || !selection.empty || selection.$from.parentOffset !== 0) return false
      const { calloutPos, callout } = at
      const paragraph = state.schema.nodes.paragraph
      const blocks: PMNode[] = [paragraph.create(null, callout.firstChild?.content)]
      callout.forEach((child, _offset, index) => {
        if (index === 0) return
        if (callout.childCount === 2 && child.type === paragraph && child.content.size === 0) return
        blocks.push(child)
      })
      const $pos = state.doc.resolve(calloutPos)
      if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.fromArray(blocks))) return false
      if (dispatch) {
        const tr = state.tr.replaceWith(calloutPos, calloutPos + callout.nodeSize, blocks)
        tr.setSelection(TextSelection.create(tr.doc, calloutPos + 1))
        dispatch(tr.scrollIntoView())
      }
      return true
    },
    // 閉じたトグルのタイトルの行の末尾で Enter: 中身ではなく、トグルの後ろに新しい行を作る(Notion と同じ)
    Enter: (state, dispatch) => {
      const { selection } = state
      const at = titleAt(state)
      if (!at || !selection.empty || !isToggle(at.callout) || !isClosed(state, at.calloutPos)) return false
      if (selection.$from.parentOffset !== selection.$from.parent.content.size) return false
      const after = at.calloutPos + at.callout.nodeSize
      const $after = state.doc.resolve(after)
      const paragraph = state.schema.nodes.paragraph
      if (!$after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) return false
      if (dispatch) {
        const tr = state.tr.insert(after, paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, after + 1))
        dispatch(tr.scrollIntoView())
      }
      return true
    },
  }),
)


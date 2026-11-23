import type { TreeNode } from '@/backend'

// ページやフォルダを動かしたあとのツリーを、バックエンドを待たずに手元で作る(見た目を先に動かすため)。
// 並び順は core の natural_cmp と同じ規則にする。バックエンドの移動が終わったら、本当のツリーで置き換える。

/** 子を入れる場所(ページなら同じ名前の子フォルダ、フォルダならそのもの) */
export const innerDir = (path: string) => path.replace(/\.md$/i, '')

/** path を parent(null はいちばん上)の下へ動かしたときの、新しい path */
export function movedPath(path: string, parent: string | null): string {
  const name = path.split('/').at(-1) ?? path
  return parent === null ? name : `${innerDir(parent)}/${name}`
}

/** 動かしたものと、その中にあるもの(子のページ・フォルダ)の path を、新しい path に読み替える */
export function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to
  const [a, b] = [innerDir(from), innerDir(to)]
  return p.startsWith(`${a}/`) ? b + p.slice(a.length) : p
}

// ---- 並び順(core/src/names.rs の natural_cmp と同じ) ----

type Token = string | { digits: string }

const digitValue = (c: string): number | null => {
  const code = c.codePointAt(0) ?? 0
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0xff10 && code <= 0xff19) return code - 0xff10
  return null
}

function tokens(s: string): Token[] {
  const out: Token[] = []
  let digits = ''
  const flush = () => {
    if (digits) out.push({ digits: digits.replace(/^0+/, '') })
    digits = ''
  }
  for (const c of s) {
    const d = digitValue(c)
    if (d !== null) digits += String(d)
    else {
      flush()
      out.push(c)
    }
  }
  flush()
  return out
}

const cmpChar = (x: string, y: string) => (x.codePointAt(0) ?? 0) - (y.codePointAt(0) ?? 0)

function cmpToken(x: Token, y: Token): number {
  if (typeof x !== 'string' && typeof y !== 'string') return x.digits.length - y.digits.length || (x.digits < y.digits ? -1 : x.digits > y.digits ? 1 : 0)
  // 数と文字を比べるときは、数を「0」として比べる
  return cmpChar(typeof x === 'string' ? x : '0', typeof y === 'string' ? y : '0')
}

export function naturalCompare(a: string, b: string): number {
  const [na, nb] = [a.normalize('NFC'), b.normalize('NFC')]
  const [xs, ys] = [tokens(na.toLowerCase()), tokens(nb.toLowerCase())]
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const order = cmpToken(xs[i], ys[i])
    if (order !== 0) return Math.sign(order)
  }
  if (xs.length !== ys.length) return xs.length - ys.length < 0 ? -1 : 1
  return na < nb ? -1 : na > nb ? 1 : 0
}

// ---- ツリーの組み替え ----

function relocate(node: TreeNode, from: string, to: string): TreeNode {
  return { ...node, path: remapPath(node.path, from, to), children: node.children.map((c) => relocate(c, from, to)) }
}

/**
 * path を parent の下へ動かしたツリー。動かせないと分かるとき(見つからない、同じ場所、
 * 移動先に同じ名前がある、自分の中へ動かす)は null(バックエンドの答えを待つ)。
 */
export function moveInTree(tree: TreeNode[], path: string, parent: string | null): TreeNode[] | null {
  const next = movedPath(path, parent)
  if (next === path) return null
  if (parent !== null && (parent === path || parent.startsWith(`${innerDir(path)}/`))) return null
  let moving: TreeNode | null = null
  const without = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((n) => {
      if (n.path === path) {
        moving = n
        return []
      }
      return n.children.length > 0 ? [{ ...n, children: without(n.children) }] : [n]
    })
  const rest = without(tree)
  if (!moving) return null
  const node = relocate(moving, path, next)
  const lower = next.toLowerCase()
  const insert = (children: TreeNode[]): TreeNode[] | null => {
    if (children.some((c) => c.path.toLowerCase() === lower)) return null
    return [...children, node].sort((a, b) => naturalCompare(a.title, b.title))
  }
  if (parent === null) return insert(rest)
  let ok = false
  const into = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      if (n.path === parent) {
        const children = insert(n.children)
        if (!children) return n
        ok = true
        return { ...n, children }
      }
      return n.children.length > 0 ? { ...n, children: into(n.children) } : n
    })
  const result = into(rest)
  return ok ? result : null
}

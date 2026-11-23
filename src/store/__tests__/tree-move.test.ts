import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@/backend'
import { moveInTree, movedPath, naturalCompare, remapPath } from '../tree-move'

const page = (path: string, children: TreeNode[] = []): TreeNode => ({ kind: 'page', path, title: path.split('/').at(-1)!.replace(/\.md$/, ''), children })
const folder = (path: string, children: TreeNode[] = []): TreeNode => ({ kind: 'folder', path, title: path.split('/').at(-1)!, children })
const paths = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => [n.path, ...paths(n.children)])

describe('naturalCompare(core の natural_cmp と同じ並び)', () => {
  it('数字は数の大きさで、先頭の0や全角は気にせず比べる', () => {
    const names = ['10日', '2日', '０３日', 'B', 'a', '1日']
    expect([...names].sort(naturalCompare)).toEqual(['1日', '2日', '０３日', '10日', 'a', 'B'])
  })
})

describe('移動先の path', () => {
  it('ページの下は子フォルダ、フォルダの下はその中、null はいちばん上', () => {
    expect(movedPath('a/b.md', 'c/d.md')).toBe('c/d/b.md')
    expect(movedPath('a/b', 'c')).toBe('c/b')
    expect(movedPath('a/b.md', null)).toBe('b.md')
  })

  it('動かしたページの子ページの path も読み替える', () => {
    expect(remapPath('a/b/x.md', 'a/b.md', 'c/b.md')).toBe('c/b/x.md')
    expect(remapPath('a/bb.md', 'a/b.md', 'c/b.md')).toBe('a/bb.md')
  })
})

describe('moveInTree', () => {
  const tree = [folder('仕事', [page('仕事/会議.md', [page('仕事/会議/10月.md')]), page('仕事/日報.md')]), folder('学び', [page('学び/本.md')])]

  it('子ページごと動かし、移動先の中で名前の順に入れる', () => {
    const next = moveInTree(tree, '仕事/会議.md', '学び')!
    expect(paths(next)).toEqual(['仕事', '仕事/日報.md', '学び', '学び/会議.md', '学び/会議/10月.md', '学び/本.md'])
  })

  it('同じ名前がある・自分の中へ・同じ場所なら null', () => {
    const dup = [...tree, page('日報.md')]
    expect(moveInTree(dup, '日報.md', '仕事')).toBeNull()
    expect(moveInTree(tree, '仕事', '仕事/会議.md')).toBeNull()
    expect(moveInTree(tree, '仕事/日報.md', '仕事')).toBeNull()
  })
})

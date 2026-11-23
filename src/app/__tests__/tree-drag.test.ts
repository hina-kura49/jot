// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@/backend'
import { DRAG_THRESHOLD, dropTargetAt, isPrimaryButtonHeld, isSamePlace, movedEnoughToDrag } from '../tree-drag'

const page = (path: string, children: TreeNode[] = []): TreeNode => ({ kind: 'page', path, title: path, children })
const folder = (path: string, children: TreeNode[] = []): TreeNode => ({ kind: 'folder', path, title: path, children })

const tree = [folder('f', [page('f/a.md', [page('f/a/b.md')])]), page('x.md')]

describe('dropTargetAt', () => {
  it('行の真ん中ならその中へ', () => {
    expect(dropTargetAt(tree, 'x.md', { path: 'f/a.md', parent: 'f' }, 0.5)).toEqual({ mode: 'into', row: 'f/a.md', parent: 'f/a.md' })
  })

  it('行の上端・下端なら、その行と同じ場所へ', () => {
    expect(dropTargetAt(tree, 'x.md', { path: 'f/a.md', parent: 'f' }, 0.1)).toEqual({ mode: 'beside', row: 'f/a.md', after: false, parent: 'f' })
    expect(dropTargetAt(tree, 'x.md', { path: 'f/a.md', parent: 'f' }, 0.9)).toEqual({ mode: 'beside', row: 'f/a.md', after: true, parent: 'f' })
  })

  it('行のない場所なら、いちばん上の階層へ', () => {
    expect(dropTargetAt(tree, 'f/a.md', null, 0)).toEqual({ mode: 'root', parent: null })
  })

  it('自分自身やその中へは入れられない', () => {
    expect(dropTargetAt(tree, 'f/a.md', { path: 'f/a.md', parent: 'f' }, 0.5)).toBeNull()
    expect(dropTargetAt(tree, 'f', { path: 'f/a/b.md', parent: 'f/a.md' }, 0.5)).toBeNull()
    expect(dropTargetAt(tree, 'f', { path: 'f/a/b.md', parent: 'f/a.md' }, 0.9)).toBeNull()
  })

  it('自分の行の上端・下端は、いまと同じ場所', () => {
    const target = dropTargetAt(tree, 'f/a.md', { path: 'f/a.md', parent: 'f' }, 0.1)
    expect(target && isSamePlace(target, 'f')).toBe(true)
  })
})

describe('つかみ始めの判定', () => {
  const start = { x: 100, y: 100 }

  it('トラックパッドを押し込むときの小さなずれでは、つかまない', () => {
    expect(DRAG_THRESHOLD).toBe(8)
    expect(movedEnoughToDrag(start, { x: 104, y: 100 })).toBe(false)
    expect(movedEnoughToDrag(start, { x: 105, y: 105 })).toBe(false)
    expect(movedEnoughToDrag(start, { x: 107, y: 100 })).toBe(false)
  })

  it('8px 動かすと、つかむ', () => {
    expect(movedEnoughToDrag(start, { x: 108, y: 100 })).toBe(true)
    expect(movedEnoughToDrag(start, { x: 100, y: 92 })).toBe(true)
  })

  it('左ボタンを離していたら、押したままとみなさない', () => {
    expect(isPrimaryButtonHeld(1)).toBe(true)
    expect(isPrimaryButtonHeld(3)).toBe(true)
    expect(isPrimaryButtonHeld(0)).toBe(false)
    expect(isPrimaryButtonHeld(2)).toBe(false)
  })
})

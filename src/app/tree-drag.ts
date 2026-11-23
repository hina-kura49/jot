import type { TreeNode } from '@/backend'
import { ancestorsOf } from '@/store/app'

// サイドバーで行をつかんで、ページやフォルダを別の場所へ動かす(Notion と同じ動き)。
// 並び順はバックエンドが決める(名前の順)ので、決めるのは「どこの中に入れるか」だけ。
// - 行の真ん中あたりに重ねる: その行(ページ・フォルダ)の中へ入れる
// - 行の上端・下端に重ねる: その行と同じ場所(親の中)へ入れる。線で示す
// - 行のない下の空白に重ねる: いちばん上の階層へ入れる

/** 落とす場所。parent は入れる先(null はいちばん上の階層) */
export type DropTarget =
  | { mode: 'into'; row: string; parent: string }
  | { mode: 'beside'; row: string; after: boolean; parent: string | null }
  | { mode: 'root'; parent: null }

// つかんだとみなす決まりは src/lib/drag.ts
export { DRAG_THRESHOLD, isPrimaryButtonHeld, movedEnoughToDrag } from '@/lib/drag'

/** 行の上端・下端として扱う割合(残りの真ん中が「中へ入れる」) */
const EDGE = 0.25

/**
 * つかんでいる行(dragged)を、行 hovered の上下の位置 fraction(0 が上端、1 が下端)に重ねたときの落とす場所。
 * hovered が null なら行のない場所。入れられない場所(自分自身やその中)なら null
 */
export function dropTargetAt(
  tree: TreeNode[],
  dragged: string,
  hovered: { path: string; parent: string | null } | null,
  fraction: number,
): DropTarget | null {
  let target: DropTarget
  if (!hovered) target = { mode: 'root', parent: null }
  else if (fraction >= EDGE && fraction <= 1 - EDGE) target = { mode: 'into', row: hovered.path, parent: hovered.path }
  else target = { mode: 'beside', row: hovered.path, after: fraction > 1 - EDGE, parent: hovered.parent }
  // 自分自身やその中へは入れられない
  if (target.parent !== null && ancestorsOf(tree, target.parent).some((n) => n.path === dragged)) return null
  return target
}

/** 落としても場所が変わらないか(いまと同じ親) */
export const isSamePlace = (target: DropTarget, currentParent: string | null) => target.parent === currentParent

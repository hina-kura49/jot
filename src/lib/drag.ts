// つかんで動かす操作の共通の決まり(サイドバーの行など)。

/**
 * これだけ動かしたら、クリックではなくつかんだとみなす。
 * トラックパッドは押し込むときに指が少しずれるので、4px では押しただけでつかんでしまった
 */
export const DRAG_THRESHOLD = 8

/** 押した位置から十分に動いたか。動いていなければ、まだクリックとして扱う */
export const movedEnoughToDrag = (start: { x: number; y: number }, pointer: { x: number; y: number }) =>
  Math.hypot(pointer.x - start.x, pointer.y - start.y) >= DRAG_THRESHOLD

/**
 * 左ボタンが押されたままか。mousemove の buttons で見る。
 * 窓の外や OS の操作で離した合図(mouseup)を取りこぼすと、離したあともつかんだままになるので、これでやめる
 */
export const isPrimaryButtonHeld = (buttons: number) => (buttons & 1) === 1

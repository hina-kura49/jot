import type { EditorView } from '@milkdown/kit/prose/view'
import { canAnimate, cssVar, duration, easing } from '@/lib/motion'
import { childElements, LIFT_SCALE, moveChild, settleChildren, snapshotChildren, type Container } from './block-move'

/**
 * ハンドルをつまんでブロック(またはリストの項目)を並べ替える。動かせるのは同じ入れ物の中だけ。
 * - つまんだブロックは少し持ち上がってポインタに付いて動き、周りのブロックは滑って場所を空ける
 *   挿入位置の線は出さない。空いた場所が、離したときに収まる場所になる
 * - 周りのブロックは、つまんだブロックの端がそのブロックの中ほどを越えたら動く(中心どうしで比べるより早く、押しのけるように動く)
 * - 離すと、つまんだブロックが新しい場所へ収まる。Esc で取りやめると元の場所へ戻る
 * - 開始時に位置を一度だけ読み、移動中は計算と、位置が変わるブロックの動きの書き換えだけを行う
 *   (数百ブロックでも、毎フレームのレイアウト再計算を起こさない)
 *
 * エディタの中の要素には、クラスも style も書き込まない。ProseMirror は属性の書き換えを文書の変更と受け取り、
 * そのブロックの要素を作り直す(つまんだブロックがポインタに付いてこなくなる)。
 * 動きは Web Animations で付け、持ち上げた見た目は、エディタの外に置く <style> で付ける。
 */
export function startBlockDrag(view: EditorView, container: Container, index: number, event: PointerEvent, scroller: HTMLElement): void {
  const els = childElements(view, container)
  const dragged = els[index]
  if (!dragged) return
  const rects = els.map((el) => el.getBoundingClientRect())
  const own = rects[index]
  const nextTop = rects[index + 1]?.top ?? rects[index - 1]?.bottom
  const gap = index + 1 < rects.length ? nextTop - own.bottom : own.top - (nextTop ?? own.top)
  const step = own.height + Math.max(0, gap)
  const startY = event.clientY
  const startScroll = scroller.scrollTop
  const mids = rects.map((r) => r.top + r.height / 2)
  const shifts = new Array<number>(els.length).fill(0)
  const shiftAnims = new Map<HTMLElement, Animation | null>()
  const shiftMs = duration('drag')
  const shiftEase = easing('move')
  const animated = canAnimate(dragged)
  let target = index
  let lastY = startY
  let raf = 0

  const lift = document.createElement('style')
  lift.textContent = `${selectorFor(view, dragged)} {
    position: relative; z-index: 5; pointer-events: none;
    background: var(--panel); border-radius: var(--radius-sm);
  }`
  document.head.append(lift)
  document.body.classList.add('block-drag-active')

  // 持ち上げ: 大きさと影を短く変える。ポインタに付いて動く位置は、別の動きの値を書き換えて付ける(fill で止まった値を保つ)
  const liftMs = animated ? duration('hover') * 1.5 : 0
  // Web Animations のない環境(テスト用など)では、動きなしで並べ替えだけ行う
  const run = (el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null =>
    typeof el.animate === 'function' ? el.animate(frames, opts) : null
  const raised = run(
    dragged,
    [
      { scale: '1', boxShadow: '0 0 0 transparent' },
      { scale: animated ? String(LIFT_SCALE) : '1', boxShadow: cssVar('shadow-lg') },
    ],
    { duration: liftMs, easing: easing('enter'), fill: 'forwards' },
  )
  const follow = run(dragged, [{ transform: 'translateY(0px)' }, { transform: 'translateY(0px)' }], { duration: 1, fill: 'forwards' })
  follow?.finish()
  const effect = follow?.effect as KeyframeEffect | null | undefined

  /** 周りのブロックを、いまの見た目の位置から次の位置へ滑らせる */
  const shiftTo = (el: HTMLElement, y: number) => {
    const from = getComputedStyle(el).transform
    shiftAnims.get(el)?.cancel()
    const to = y ? `translateY(${y}px)` : 'translateY(0px)'
    shiftAnims.set(
      el,
      run(el, [{ transform: from === 'none' ? 'translateY(0px)' : from }, { transform: to }], {
        duration: animated ? shiftMs : 0,
        easing: shiftEase,
        fill: 'forwards',
      }),
    )
  }

  const place = (clientY: number) => {
    lastY = clientY
    const scrolled = scroller.scrollTop - startScroll
    const dy = clientY - startY + scrolled
    effect?.setKeyframes([{ transform: `translateY(${dy}px)` }, { transform: `translateY(${dy}px)` }])
    // 下へ動かしているときは下端、上へ動かしているときは上端で比べる
    const top = rects[index].top + dy
    const bottom = rects[index].bottom + dy
    let up = 0
    let down = 0
    for (let i = 0; i < els.length; i++) {
      if (i === index) continue
      const want = i < index && top < mids[i] ? step : i > index && bottom > mids[i] ? -step : 0
      if (want > 0) up++
      if (want < 0) down++
      if (shifts[i] !== want) {
        shifts[i] = want
        shiftTo(els[i], want)
      }
    }
    target = index - up + down
  }

  // 端に近づいたら自動でスクロールする
  const autoScroll = () => {
    const box = scroller.getBoundingClientRect()
    const edge = 56
    const speed = lastY < box.top + edge ? -(box.top + edge - lastY) / 3 : lastY > box.bottom - edge ? (lastY - (box.bottom - edge)) / 3 : 0
    if (speed !== 0) {
      scroller.scrollTop += speed
      place(lastY)
    }
    raf = requestAnimationFrame(autoScroll)
  }
  raf = requestAnimationFrame(autoScroll)

  const finish = (commit: boolean) => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onCancel)
    // いまの見た目の位置を控えてから、動きを外して文書を並べ替え、控えた位置から滑らせる
    const before = snapshotChildren(view, container)
    const draggedRect = dragged.getBoundingClientRect()
    follow?.cancel()
    raised?.cancel()
    for (const a of shiftAnims.values()) a?.cancel()
    lift.remove()
    document.body.classList.remove('block-drag-active')
    if (commit && target !== index) {
      moveChild(view, container, index, target)
      const movedEl = childElements(view, container)[target]
      settleChildren(view, container, before, movedEl ? { el: movedEl, rect: draggedRect, lifted: true } : undefined)
    } else {
      settleChildren(view, container, before, { el: dragged, rect: draggedRect, lifted: true })
    }
    view.focus()
  }
  const onMove = (e: PointerEvent) => place(e.clientY)
  const onUp = () => finish(true)
  const onCancel = () => finish(false)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
  // ドラッグ中にほかのアプリへ切り替えたら(離す操作が届かないので)取りやめる
  window.addEventListener('blur', onCancel)
  place(startY)
}

/** エディタの中での要素の場所を表すセレクタ(要素に印を付けずに、外の <style> から見た目を変えるため) */
function selectorFor(view: EditorView, el: HTMLElement): string {
  const steps: string[] = []
  let node: HTMLElement = el
  while (node !== view.dom && node.parentElement) {
    steps.unshift(`:nth-child(${Array.prototype.indexOf.call(node.parentElement.children, node) + 1})`)
    node = node.parentElement
  }
  const root = view.dom.id ? `#${CSS.escape(view.dom.id)}` : '.ProseMirror'
  return [root, ...steps].join(' > ')
}

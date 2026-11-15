/**
 * 等待指定 CSS 属性真正结束，并保证收尾回调只执行一次。
 * transitionend 不能使用 { once: true }，否则更快结束的 opacity 会提前消耗监听器。
 */

export function onTransitionEndOnce(
  el: HTMLElement | null | undefined,
  prop: string,
  fn: () => void,
  fallbackMs = 400
): () => void {
  if (!el || typeof fn !== 'function') return () => {}

  let finished = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const finish = (): void => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    if (timer !== null) clearTimeout(timer)
    timer = null
    fn()
  }

  const onEnd = (event: TransitionEvent): void => {
    if (event && event.propertyName === prop) finish()
  }

  el.addEventListener('transitionend', onEnd)
  if (fallbackMs > 0) timer = setTimeout(finish, fallbackMs)
  return finish
}

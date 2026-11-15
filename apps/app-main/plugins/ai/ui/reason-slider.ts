/**
 * AI 面板 · 思考强度滑块（输入区「推理等级」的控件本体，零 IPC / 零业务）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是滑块，不是下拉列表
 * ══════════════════════════════════════════════════════════════════════
 * 推理等级是**一条有方向的轴**（越往右越费 token、越深入），列表把这种"连续感"
 * 压成了四个等权条目。滑块把方向直接画出来：轨道、停靠点、当前档位的位置。
 *
 * 三条硬规矩：
 *   1. **拖动只预览，松手才落库**：拖到一半就写设置会让整个面板（流式 token、
 *      用量）跟着重渲染，滑块一卡一卡地跳。拖动期间只动本地 index。
 *   2. **重建不丢焦点**：上层每次状态变化都会重画浮层；本控件由调用方缓存复用
 *      （见 composer 的 `renderReasoning`），重建只发生在档位集合真的变了的时候。
 *   3. **键盘与指针同权**：`role="slider"` + ←/→/Home/End，不用鼠标也能调。
 *
 * 顺序由调用方给的 `options` 决定（当前是 低 → 中 → 高 → 自动）。
 */

import { attach, h } from './dom.js'

interface ReasonOption {
  value: string
  label: string
}

interface ReasonSliderConfig {
  options: ReasonOption[]
  value: string
  hints?: Record<string, string>
  onChange: (value: string) => void
}

/**
 * @param {Document} doc
 * @param {{
 *   options: Array<{ value: string, label: string }>,
 *   value: string,
 *   hints?: Record<string, string>,
 *   onChange: (value: string) => void
 * }} config
 * @returns {{
 *   element: HTMLElement,
 *   setValue: (value: string) => void,
 *   isDragging: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createReasonSlider(doc: Document, { options, value, hints = {}, onChange }: ReasonSliderConfig): {
  element: HTMLElement,
  setValue: (value: string) => void,
  isDragging: () => boolean,
  dispose: () => void
} {
  const list = Array.isArray(options) ? options.filter((o) => o && o.value) : []
  const element = h(doc, 'div', 'ai-reason')
  const rail = h(doc, 'div', 'ai-reason__rail')
  const head = h(doc, 'div', 'ai-reason__head')
  head.appendChild(h(doc, 'span', 'ai-reason__title', '思考强度'))
  const valueTag = h(doc, 'span', 'ai-reason__value')
  head.appendChild(valueTag)

  const track: HTMLElement = /** @type {HTMLElement} */ (h(doc, 'div', 'ai-reason__track'))
  track.tabIndex = 0
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', '思考强度')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', String(Math.max(0, list.length - 1)))

  const fill = h(doc, 'div', 'ai-reason__fill')
  track.appendChild(fill)

  /**
   * 停靠点 / 档位标签的横向位置。
   *
   * 与手柄、推进条走**同一条行程公式**：两端各让出半个手柄宽 + end-gap，
   * 手柄滑到 0% / 100% 时上下左右都被轨道包住，不会探出轨道的圆角。
   * 用 calc + CSS 变量而不是在这里写死像素：手柄尺寸只在样式里定义一次。
   */
  function travelLeft(i: number): string {
    const t = list.length > 1 ? i / (list.length - 1) : 0
    return `calc(var(--ai-reason-half) + var(--ai-reason-end-gap) + ${t} * (100% - var(--ai-reason-thumb-w) - 2 * var(--ai-reason-end-gap)))`
  }

  const dots: HTMLElement[] = []
  for (let i = 0; i < list.length; i++) {
    const dot = h(doc, 'span', 'ai-reason__dot')
    dot.style.left = travelLeft(i)
    dots.push(dot)
    track.appendChild(dot)
  }

  const thumb = h(doc, 'div', 'ai-reason__thumb')
  track.appendChild(thumb)

  const labels = h(doc, 'div', 'ai-reason__labels')
  const labelEls: HTMLElement[] = []
  for (let i = 0; i < list.length; i++) {
    const el = h(doc, 'span', 'ai-reason__label', list[i].label)
    el.style.left = travelLeft(i)
    // 两端的字不越界：首项左对齐、末项右对齐，中间居中对齐停靠点
    el.style.transform = i === 0 ? 'translateX(0)'
      : i === list.length - 1 ? 'translateX(-100%)'
        : 'translateX(-50%)'
    el.addEventListener('click', () => commit(i))
    labelEls.push(el)
    labels.appendChild(el)
  }

  const hint = h(doc, 'div', 'ai-reason__hint')
  attach(rail, track, labels)
  attach(element, head, rail, hint)

  // ── 位置模型 ────────────────────────────────────────────────────────
  // `pos` 是**连续**位置（0 ~ n-1 的小数），`target` 是它要去的地方。
  // 每一帧按缓动逼近 target —— 拖动、键盘、外部回流都走这一套，所以永远
  // 是"滑过去"而不是"跳过去"；只有松手时才吸到最近的停靠点并落库。
  const win = doc.defaultView
  const raf: (callback: FrameRequestCallback) => number = win && typeof win.requestAnimationFrame === 'function'
    ? (callback) => win.requestAnimationFrame(callback)
    : (callback) => setTimeout(() => callback(0), 16) as unknown as number
  const cancelRaf: (handle: number) => void = win && typeof win.cancelAnimationFrame === 'function'
    ? (handle) => win.cancelAnimationFrame(handle)
    : (handle) => clearTimeout(handle)

  let pos = Math.max(0, list.findIndex((o) => o.value === value))
  let target = pos
  let startIndex = Math.round(pos)
  let dragging = false
  let pointerId = -1
  let frame = 0
  let lastHeat = -1

  // ── 热度曲线 ────────────────────────────────────────────────────────
  // 「紫色 + 星点」不是一个档位的开关，而是**沿轴连续升温**的强度：
  // 低 / 中保持主题色 → 从中开始升温 → 到「高」满格 → 「自动」沿用满格。
  // 把这条曲线交给 CSS 变量后，拖动经过临界点时是渐进去色，不会"啪"地变紫。
  const warmFrom = Math.max(0, list.findIndex((o) => o.value === 'medium'))
  const warmTo = (() => {
    const high = list.findIndex((o) => o.value === 'high')
    return high > warmFrom ? high : Math.max(warmFrom, list.length - 1)
  })()

  function clampPos(v: number): number {
    return Math.max(0, Math.min(list.length - 1, v))
  }

  function currentIndex() {
    return Math.max(0, Math.min(list.length - 1, Math.round(pos)))
  }

  /** 只画，不通知上层（动画期间每帧都走这里）。 */
  function paint() {
    // 无量纲连续位置 0..1：样式层用它算手柄 / 推进条的行程（两端各让半个手柄）
    const span = Math.max(1, list.length - 1)
    rail.style.setProperty('--ai-reason-t', String(Math.max(0, Math.min(1, pos / span))))
    const idx = currentIndex()
    const opt = list[idx] || list[0] || { value: '', label: '' }
    if (valueTag.textContent !== opt.label) valueTag.textContent = opt.label
    for (let i = 0; i < dots.length; i++) {
      // 越过的停靠点点亮（玻璃珠 → 白色发光），当前档位那颗被拇指盖住
      dots[i].classList.toggle('is-passed', i < idx)
      dots[i].classList.toggle('is-active', i === idx)
    }
    for (let i = 0; i < labelEls.length; i++) {
      labelEls[i].classList.toggle('is-active', i === idx)
    }
    const text = hints[opt.value] || ''
    if (hint.textContent !== text) hint.textContent = text
    // 热度用**连续位置**算，不等档位切换 —— 颜色、星点透明度都按它插值
    const heat = warmTo > warmFrom
      ? Math.min(1, Math.max(0, (pos - warmFrom) / (warmTo - warmFrom)))
      : 0
    if (heat !== lastHeat) {
      lastHeat = heat
      element.style.setProperty('--ai-reason-heat', heat.toFixed(3))
      element.style.setProperty('--ai-reason-heat-pct', `${(heat * 100).toFixed(1)}%`)
    }
    track.setAttribute('aria-valuenow', String(idx))
    track.setAttribute('aria-valuetext', opt.label)
    track.title = `思考强度：${opt.label}`
  }

  /** 平滑逼近 target：指数缓动，帧率越高越跟手；差值小于半像素就收口。 */
  function animate() {
    if (frame) return
    const step = () => {
      frame = 0
      const d = target - pos
      if (Math.abs(d) < 0.003) {
        pos = target
        paint()
        return
      }
      pos += d * 0.32
      paint()
      frame = raf(step)
    }
    frame = raf(step)
  }

  function moveTo(next: number, smooth: boolean = true): void {
    target = clampPos(next)
    if (!smooth) {
      pos = target
      paint()
      return
    }
    animate()
  }

  /** 落库（键盘 / 点标签 / 松手时各调一次；同值不重复通知）。 */
  function commit(next: number): void {
    const clamped = clampPos(Math.round(next))
    const same = clamped === currentIndex() && Math.abs(target - clamped) < 0.001
    moveTo(clamped)
    if (same) return
    const opt = list[clamped]
    if (opt && typeof onChange === 'function') onChange(opt.value)
  }

  /** 行程两端的让位（px），首次换算时从 CSS 变量读一次 —— 尺寸仍只有样式一处真源。 */
  let endGap: number | null = null
  function readEndGap() {
    if (endGap !== null) return endGap
    const cs = doc.defaultView ? doc.defaultView.getComputedStyle(rail) : null
    const v = cs ? parseFloat(cs.getPropertyValue('--ai-reason-end-gap')) : NaN
    endGap = Number.isFinite(v) ? v : 0
    return endGap
  }

  /** 指针位置 → 连续档位坐标（不再四舍五入，滑动才是连续的）。 */
  function positionFromEvent(e: PointerEvent): number {
    if (list.length < 2) return 0
    const rect = track.getBoundingClientRect()
    if (!rect.width) return target
    // 换算用与手柄**完全相同**的行程段（轨道宽 - 手柄宽 - 两端让位）：
    // 否则按下瞬间手柄会从指针底下"弹开"半个手柄。
    const thumbW = thumb.offsetWidth || 0
    const gap = readEndGap()
    const usable = Math.max(1, rect.width - thumbW - gap * 2)
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - thumbW / 2 - gap) / usable))
    return ratio * (list.length - 1)
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragging = true
    startIndex = currentIndex()
    pointerId = e.pointerId
    element.classList.add('is-dragging')
    moveTo(positionFromEvent(e))
    try { track.setPointerCapture(e.pointerId) } catch (_) { /* 老宿主没有捕获 */ }
    try { track.focus() } catch (_) {}
  })

  track.addEventListener('pointermove', (e) => {
    if (!dragging) return
    moveTo(positionFromEvent(e))
  })

  function endDrag() {
    if (!dragging) return
    dragging = false
    element.classList.remove('is-dragging')
    try { track.releasePointerCapture(pointerId) } catch (_) {}
    pointerId = -1
    // 松手吸到最近停靠点（仍是平滑落位），档位真的变了才写设置
    const next = clampPos(Math.round(target))
    moveTo(next)
    if (next === startIndex) return
    const opt = list[next]
    if (opt && typeof onChange === 'function') onChange(opt.value)
  }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  track.addEventListener('keydown', (e) => {
    const last = Math.max(0, list.length - 1)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      commit(currentIndex() - 1)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      commit(currentIndex() + 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      commit(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      commit(last)
    }
  })

  paint()

  return {
    element,
    /** 外部（store 状态回流 / 换模型后）更新当前档位，不触发 onChange。 */
    setValue(next) {
      if (dragging) return
      const found = list.findIndex((o) => o.value === next)
      if (found < 0 || Math.abs(target - found) < 0.001) return
      moveTo(found)
    },
    isDragging() { return dragging },
    dispose() {
      if (frame) cancelRaf(frame)
      frame = 0
      labels.textContent = ''
      track.textContent = ''
    }
  }
}

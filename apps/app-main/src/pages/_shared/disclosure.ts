/**
 * 折叠组（disclosure）的唯一实现。
 *
 * 结构 / 视觉契约见 base.css 的「折叠组」段：
 *   .disclosure > button.disclosure-head[aria-expanded] + .disclosure-body[hidden]
 * 页面只负责：标题、计数、内容行，以及「展开状态要不要记住」。
 *
 * 为什么不在各页各写一遍：cookies 按域名折叠、密码按站点折叠、将来书签 / 扩展
 * 也会折叠。任何一处改间距、改箭头、改无障碍属性，都必须同时生效。
 */
import { el } from 'hira://shared/runtime.js'

/**
 * @param {object} options
 * @param {string} options.title            组标题（域名 / 站点名）
 * @param {string|number} [options.count]   右侧药丸计数，空串自动隐藏
 * @param {boolean} [options.open]          初始是否展开
 * @param {[string, string]} [options.hint] [收起时的提示, 展开时的提示]
 * @param {(open: boolean) => void} [options.onToggle] 仅用户点击时回调（程序化 setOpen 不触发）
 */
export interface DisclosureOptions {
  title: string
  count?: string | number
  open?: boolean
  hint?: [string, string]
  onToggle?: (open: boolean) => void
}

export interface DisclosureController {
  root: HTMLElement
  head: HTMLButtonElement
  body: HTMLElement
  readonly open: boolean
  setOpen(open?: boolean): void
  setCount(value?: string | number | undefined): void
  setTitle(value?: string): void
}

export function createDisclosure (options: DisclosureOptions): DisclosureController {
  const {
    title,
    count,
    open = false,
    hint = ['展开', '收起'],
    onToggle
  } = options

  const root = el('section', 'disclosure')
  const head = el('button', 'disclosure-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(open))

  head.appendChild(el('span', 'disclosure-arrow'))
  const titleEl = el('span', 'disclosure-title', title)
  head.appendChild(titleEl)
  const countEl = el('span', 'count', count === undefined ? '' : String(count))
  head.appendChild(countEl)
  const hintEl = el('span', 'disclosure-hint', open ? hint[1] : hint[0])
  head.appendChild(hintEl)

  const body = el('div', 'disclosure-body')
  body.hidden = !open

  // 程序化调用（渲染期恢复状态）不回调，避免把「恢复」当成用户动作再写一遍状态
  const apply = (next?: boolean): void => {
    body.hidden = !next
    head.setAttribute('aria-expanded', String(next))
    hintEl.textContent = next ? hint[1] : hint[0]
  }

  head.addEventListener('click', () => {
    const next = body.hidden
    apply(next)
    if (typeof onToggle === 'function') onToggle(next)
  })

  root.appendChild(head)
  root.appendChild(body)

  return {
    root,
    head,
    body,
    get open () {
      return !body.hidden
    },
    setOpen: apply,
    setCount (value?: string | number | undefined): void {
      countEl.textContent = value === undefined ? '' : String(value)
    },
  setTitle (value = ''): void {
      titleEl.textContent = value
    }
  }
}

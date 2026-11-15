/**
 * address-autofill —— 「地址 / 支付卡」页面侧自动填充（N7 的填充那一半）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 用户在**地址 / 支付卡字段**上聚焦或点击时，浮出一份已保存条目，
 * 选中后把值写进同一表单里的各个字段。
 *
 * ── 为什么与 password-autofill 分开 ────────────────────────────────
 * 两者的**触发判据**与**填充范围**都不同：密码是"用户名 + 密码两个框"，
 * 靠评分与策略链挑；地址/卡是"一组语义明确的框"，靠 `autocomplete`（标准声明）挑。
 * 混在一个引擎里会让两套判据互相干扰（例如把"收货人姓名"当成登录用户名）。
 * 共用的只有**写入器**（fill.js 的 setInputValueWithEvents / 高亮 / 覆盖保护）——
 * 那是真正相同的部分，直接复用，不复制一份。
 *
 * ── 性能纪律（与密码引擎同一条）────────────────────────────────────
 * **绝不扫描全文档**：只在"用户交互到某个输入框"时判断那一个框；
 * 真正要填时也只在该框所属的 `<form>` 内查找（没有 form 才退化为文档查询）。
 * 因此页面上没有我们关心的字段时，本节代码的开销 = 每次交互读一个属性。
 */

import { ipcRenderer } from 'electron'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
// 字体栈唯一真源（薄模块：常量内联，不拖主题目录进每页 preload）。
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack'
// ⚠ 共享模块必须用**相对路径**引入：preload 是**沙箱**环境，`@hira-ng/*` 这类
// 包名会被 externalize 成运行时 `require('@hira-ng/…')` —— 在 sandbox 下那会当场抛错，
// 并**连带把整个 tab preload 拖垮**（密码填充、JS 对话框都会一起失效）。
// 相对路径才会被 rollup 真正打进 tab.js 单文件里（密码引擎的本地模块同理）。
import {
  AUTOCOMPLETE_KEY_MAP,
  CARD_FIELDS,
  ADDRESS_FIELDS
} from '@hira-ng/shared-types/src/form-fill'
import { createAutofillFiller } from '../password-autofill/fill.js'
// 协议白名单走 shared-types 的唯一判据（与密码引擎、PWA 线索同一条）。
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'
// 可填 input type 的唯一真源（与凭据引擎共用一份清单）。
import { isTextInputType } from '../field-types.js'
// 浮层配色走主题令牌（浅 DOM，变量写到浮层根节点向下继承）。
import { applyAccentVars } from '../theme-accent.js'

/** 兜底判据：`autocomplete` 缺失时按 name/id/placeholder 认（很多站点不写标准属性）。 */
const KEY_PATTERNS: Array<[string, RegExp]> = [
  // 卡相关放前面：`cardholder` 之类不应被"姓名"类模式抢先匹配。
  ['expMonth', /(exp[^a-z]*month|expiry[^a-z]*mm|有效期[^。]{0,4}月|有效期月份)/i],
  ['expYear', /(exp[^a-z]*year|expiry[^a-z]*yy|有效期[^。]{0,4}年|有效期年份)/i],
  ['number', /(card[^a-z]*number|cc[^a-z]*number|卡号)/i],
  ['holder', /(card[^a-z]*holder|name[^a-z]*on[^a-z]*card|持卡人)/i],
  ['postalCode', /(postal|postcode|zip|邮编|邮政编码)/i],
  ['phone', /(phone|mobile|tel|手机|电话)/i],
  ['email', /(e-?mail|邮箱)/i],
  ['region', /(province|state|region|省|州)/i],
  ['city', /(city|town|城市)/i],
  ['street', /(street|address|addr|详细地址|街道|地址)/i],
  ['organization', /(company|organization|org|单位|公司)/i],
  ['name', /(fullname|full[^a-z]*name|realname|lastname|firstname|姓名|收货人|联系人)/i]
]

/** 我们关心的字段键集合（用于校验 resolveKey 的结果）。 */
const ALL_KEYS = new Set([...ADDRESS_FIELDS, ...CARD_FIELDS].map(([k]) => k))

function isFillable(el: unknown): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false
  if (!isTextInputType(el.getAttribute('type'))) return false
  if (el.disabled || el.readOnly) return false
  return true
}

/** 读某个输入框属于哪个字段键（标准 autocomplete 优先，其次模式匹配）。 */
function resolveKey(el: unknown): string | null {
  if (!isFillable(el)) return null
  const ac = String(el.getAttribute('autocomplete') || '').trim().toLowerCase()
  if (ac && Object.prototype.hasOwnProperty.call(AUTOCOMPLETE_KEY_MAP, ac)) {
    return (AUTOCOMPLETE_KEY_MAP as Record<string, string>)[ac]
  }
  const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')]
    .filter(Boolean).join(' ')
  if (!hay) return null
  for (const [key, re] of KEY_PATTERNS) if (re.test(hay)) return key
  return null
}

/** 字段键 → 条目类型（决定该浮出"地址"还是"卡"）。 */
function kindOfKey(key: string): 'card' | 'address' {
  return CARD_FIELDS.some(([k]) => k === key) ? 'card' : 'address'
}

/** 极简浮层：一列条目 + 点击选中（内联样式，避免被站点 CSS 影响布局）。 */
interface AutofillMenuItem {
  id: unknown
  label: string
  detail?: string
  data?: Record<string, unknown>
}

function createMenu(): {
  show(anchorEl: HTMLInputElement, items: AutofillMenuItem[], onPick: (item: AutofillMenuItem) => void): void
  dismiss(): void
  isOpen(): boolean
} {
  let host: HTMLDivElement | null = null

  function dismiss(): void {
    if (!host) return
    try { host.remove() } catch (_) {}
    host = null
  }

  function show(anchorEl: HTMLInputElement, items: AutofillMenuItem[], onPick: (item: AutofillMenuItem) => void): void {
    dismiss()
    if (!anchorEl || !items.length) return
    const rect = anchorEl.getBoundingClientRect()
    const hostEl = document.createElement('div')
    hostEl.setAttribute('data-hira-formfill', '1')
    Object.assign(hostEl.style, {
      all: 'initial',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      position: 'fixed',
      inset: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '2147483647'
    })
    const shadow = hostEl.attachShadow({ mode: 'closed' })
    const box = document.createElement('div')
    Object.assign(box.style, {
      position: 'fixed',
      left: `${Math.max(4, Math.round(rect.left))}px`,
      top: `${Math.round(rect.bottom + 4)}px`,
      minWidth: `${Math.max(180, Math.round(rect.width))}px`,
      maxWidth: '360px',
      zIndex: '2147483647',
      background: 'var(--hira-bg-surface, #fff)',
      color: 'var(--hira-text-primary, #1a1a1a)',
      border: '1px solid var(--hira-border-subtle, rgba(0,0,0,.14))',
      borderRadius: '8px',
      boxShadow: '0 6px 24px rgba(0,0,0,.18)',
      padding: '4px',
      pointerEvents: 'auto',
      font: `13px/1.4 ${uiFontVar()}`
    })
    // 主题令牌写到浮层根节点：表面 / 文字 / 边框 / hover 全部跟随主题。
    try { applyAccentVars(box) } catch (_) {}
    for (const item of items) {
      const row = document.createElement('div')
      Object.assign(row.style, {
        padding: '7px 9px',
        borderRadius: '6px',
        cursor: 'pointer'
      })
      const title = document.createElement('div')
      title.textContent = item.label || '(未命名)'
      Object.assign(title.style, { fontWeight: '600' })
      row.appendChild(title)
      if (item.detail) {
        const sub = document.createElement('div')
        sub.textContent = item.detail
        Object.assign(sub.style, { fontSize: '11px', opacity: '.66' })
        row.appendChild(sub)
      }
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--hira-accent-soft, rgba(0,0,0,.06))' })
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
      row.addEventListener('mousedown', (e: MouseEvent) => {
        if (!e.isTrusted) return
        // 阻止默认：否则这次 mousedown 会先让输入框失焦，随后我们的重新聚焦会闪一下。
        e.preventDefault()
        e.stopPropagation()
        dismiss()
        onPick(item)
      })
      box.appendChild(row)
    }
    shadow.appendChild(box)
    ;(document.body || document.documentElement).appendChild(hostEl)
    host = hostEl
  }

  return { show, dismiss, isOpen: () => !!host }
}

/** 只在真实网页（http / https）上运行 —— 与密码引擎同一条协议白名单。 */
function isHttpPage(): boolean {
  try {
    return isHttpProtocol(window.location.protocol)
  } catch (_) {
    return false
  }
}

/**
 * 启动地址 / 支付卡自动填充。
 * @param {{ provider: { invoke:Function }, subscribe?: Function }} options
 */
interface FormFillProvider { invoke(route: string, payload: unknown): Promise<unknown> | unknown }
interface AddressAutofillOptions { provider?: FormFillProvider }

export function startAddressAutofill(options: AddressAutofillOptions = {}): { dispose(): void } {
  const provider = options.provider
  if (!provider || typeof provider.invoke !== 'function') return { dispose: () => {} }
  const activeProvider = provider

  const filler = createAutofillFiller()
  const menu = createMenu()
  /** 最近交互的那个字段（填充时作为"填哪一块表单"的定位锚点）。 */
  let anchorField: HTMLInputElement | null = null
  let disposed = false

  function dismiss() { menu.dismiss() }

  /** 把某个条目的值写进**同一表单**里语义匹配的字段。 */
  function fillEntry(entry: AutofillMenuItem, kind: 'card' | 'address'): number {
    const anchor = anchorField
    if (!anchor || !entry) return 0
    const scope = anchor.form || document
    let written = 0
    const inputs = scope.querySelectorAll ? scope.querySelectorAll('input') : []
    for (const el of inputs) {
      const key = resolveKey(el)
      if (!key || kindOfKey(key) !== kind) continue
      const value = entry.data?.[key]
      if (value == null || value === '') continue
      filler.setInputValueWithEvents(el, value)
      filler.applyAutofillHighlight(el)
      filler.armAutofillOverwrite(el)
      written++
    }
    return written
  }

  function openForField(field: HTMLInputElement): void {
    const key = resolveKey(field)
    if (!key || !ALL_KEYS.has(key)) return
    const kind = kindOfKey(key)
    anchorField = field
    // 只在真的要填时才请求明文（主进程还会按 `privacy.form_autofill` 开关把关）。
    Promise.resolve(activeProvider.invoke(PRELOAD_ROUTES.formFillOptions, { kind })).then(
      (res: unknown) => {
        if (disposed) return
        const result = res && typeof res === 'object' ? res as { items?: unknown } : null
        const items = (result && Array.isArray(result.items)) ? result.items as AutofillMenuItem[] : []
        if (!items.length) return
        menu.show(field, items.map((it: AutofillMenuItem) => ({
          id: it.id,
          label: it.label,
          detail: it.detail,
          data: it.data
        })), (picked: AutofillMenuItem) => {
          fillEntry(picked, kind)
        })
      },
      () => {}
    )
  }

  function onInteract(e: Event): void {
    if (e.isTrusted === false) return
    if (e.type === 'focusin') {
      let active = false
      try {
        active = !navigator.userActivation || navigator.userActivation.isActive
      } catch (_) {}
      // Programmatic focus must not be enough to expose saved addresses / cards.
      if (!active) return
    }
    const t = e && e.target
    if (!isFillable(t)) { dismiss(); return }
    // 已开着时，点击任意处先收起（与密码浮层同一交互约定：行为可预测）。
    if (menu.isOpen()) dismiss()
    openForField(t)
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && menu.isOpen()) dismiss()
  }
  function onInput(e: Event): void {
    if (e && e.isTrusted !== false) dismiss()
  }

  // 只在真实网页上工作（与密码引擎同一条协议白名单）。
  if (!isHttpPage()) return { dispose: () => {} }

  window.addEventListener('focusin', onInteract, true)
  window.addEventListener('mousedown', onInteract, true)
  window.addEventListener('keydown', onKeydown, true)
  // 有真实输入即收起（合成事件不算）。
  window.addEventListener('input', onInput, true)
  window.addEventListener('scroll', dismiss, true)

  return {
    dispose() {
      disposed = true
      dismiss()
      window.removeEventListener('focusin', onInteract, true)
      window.removeEventListener('mousedown', onInteract, true)
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('input', onInput, true)
      window.removeEventListener('scroll', dismiss, true)
    }
  }
}

// ── preload 自启动（薄：只在 http(s) 且用户真的交互到字段时才付出成本）──
;(function () {
  if (typeof window === 'undefined') return
  if (!isHttpPage()) return
  try {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return
    const provider = {
      invoke(route: string, payload: unknown): Promise<unknown> {
        return ipcRenderer.invoke(`ngipc:invoke:${route}`, payload)
      }
    }
    startAddressAutofill({ provider })
  } catch (e) {
    console.warn('[address-autofill] init failed:', e instanceof Error ? e.message : e)
  }
})()

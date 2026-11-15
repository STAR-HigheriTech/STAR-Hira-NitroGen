import fs from 'node:fs'
import path from 'node:path'

export type Messages = Record<string, string>
export interface LocaleBundle { messages?: Messages; [key: string]: unknown }
export type BundleProvider = LocaleBundle | (() => LocaleBundle | LocaleBundle[] | null | undefined)
export interface L10nOptions {
  locale?: string
  fallbackLocale?: string
  bundleProviders?: readonly BundleProvider[]
}
export interface L10n { locale: string; fallbackLocale: string; t(key: unknown, vars?: Record<string, unknown> | null): string; reload(): void }

export function loadLocaleSync(locale: unknown): Messages {
  const safe = String(locale || '').trim() || 'en'
  const filePath = path.join(__dirname, '..', 'locales', `${safe}.json`)
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as Messages
}

function formatTemplate(template: unknown, vars?: Record<string, unknown> | null): string {
  if (!vars) return String(template)
  return String(template).replace(/\{(\w+)\}/g, (_m, k) => {
    if (Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k])
    return `{${k}}`
  })
}

/** 把一个 bundle（`{messages:{…}}` 或直接就是 `{key: text}`）并入 merged。内建优先。 */
function mergeBundle(merged: Messages, bundle: unknown, primary: Messages, fallback: Messages): void {
  if (!bundle || typeof bundle !== 'object') return
  const record = bundle as Record<string, unknown>
  const messages = record.messages && typeof record.messages === 'object' ? record.messages as Record<string, unknown> : record
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string') continue
    // 内建优先：已有键一律不覆盖。
    if (key in primary || key in fallback) continue
    merged[key] = value
  }
}

/**
 * 本地化管理器工厂。
 *
 * `bundleProviders` 是扩展点 `l10n.bundle-provider` 的实现列表 —— 每个实现返回
 * `{ messages: { key: text } }`（或直接就是那个对象），为插件自己的 key 提供译文。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条刻意的设计决定
 * ══════════════════════════════════════════════════════════════════════
 * 1. **内建优先，插件只填缺**：`primary` / `fallback`（仓库自带语言包）里已有的键，
 *    插件给不出覆盖值。理由是"官方文案的最终解释权在官方"——否则一个插件就能悄悄
 *    改掉"删除"按钮的文案，那是钓鱼面而不是本地化。
 * 2. **惰性求值 + `reload()`**：provider 在**第一次查表**时才被调用，而不是构造时。
 *    因为插件是后台启动的（main.js 里 fire-and-forget），构造 l10n 的时刻大概率
 *    一个插件都还没加载完 —— 构造时求值等于永远拿不到插件的语言包。
 *    插件上线后调用一次 `reload()` 即可让它们生效，无需重建实例。
 */
export function createL10n({ locale = 'en', fallbackLocale = 'en', bundleProviders = [] }: L10nOptions = {}): L10n {
  const primary = loadLocaleSync(locale)
  const fallback = locale === fallbackLocale ? primary : loadLocaleSync(fallbackLocale)
  const providers = Array.isArray(bundleProviders) ? bundleProviders.filter(Boolean) : []

  /** @type {Record<string,string>|null} 惰性缓存；`reload()` 置空。 */
  let extra: Messages | null = null

  function resolveExtra(): Messages {
    if (extra) return extra
    const merged: Messages = {}
    for (const provider of providers) {
      let bundle: LocaleBundle | LocaleBundle[] | null | undefined = null
      try {
        bundle = typeof provider === 'function' ? provider({ locale, fallbackLocale }) : provider
      } catch (_) {
        bundle = null // 一个坏 provider 不该让整张表塌掉
      }
      // **数组也认**：宿主侧惯用 `() => slotCall.multi('l10n.bundle-provider', …)`，
      // 而 MULTI 插槽的返回值天然是"每个实现一个值"的数组。把数组当单个 bundle
      // 会把 messages 解析成 {0: …, 1: …} 而静默丢光所有译文 —— 这里必须展平。
      for (const item of Array.isArray(bundle) ? bundle : [bundle]) {
        mergeBundle(merged, item, primary, fallback)
      }
    }
    extra = merged
    return extra
  }

  return {
    locale,
    fallbackLocale,
    t(key: unknown, vars?: Record<string, unknown> | null) {
      const k = String(key)
      const v = primary[k] ?? fallback[k] ?? resolveExtra()[k] ?? k
      return formatTemplate(v, vars)
    },
    /** 插件集合变化后调用：丢弃已合并的插件语言包，下次查表重新求值。 */
    reload() {
      extra = null
    }
  }
}

export default {
  loadLocaleSync,
  createL10n
}

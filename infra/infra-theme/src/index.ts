import path from 'node:path'
import { readText } from '@hira-ng/infra-fs'
import { getAppRoot } from '@hira-ng/shared-utils'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeTokenName = ResolvedTheme | 'base'
export interface ExtensionPointsPort {
  call(name: string, context: unknown): Promise<unknown> | unknown
  isDefined?(name: string): boolean
}
export interface ThemeLoadOptions { extensionPoints?: ExtensionPointsPort | null; overrides?: string }
export interface WebContentsThemePort { insertCSS(css: string): Promise<void> | void }
export interface ThemeManagerOptions {
  initialTheme?: string
  prefersDark?: boolean
  extensionPoints?: ExtensionPointsPort | null
}
export interface ThemeManager {
  getTheme(): ThemePreference
  getResolvedTheme(prefersDark?: boolean): ResolvedTheme
  setTheme(next: unknown, options?: { prefersDark?: boolean; overrides?: string }): Promise<boolean>
  onChange(callback: (theme: ThemePreference, resolved: ResolvedTheme, css: string) => void): () => boolean
  applyToWebContents(webContents: WebContentsThemePort | null | undefined): Promise<boolean>
  isApplied(webContents: object): boolean
}

function getTokensPath(theme: ThemeTokenName): string {
  const file =
    theme === 'dark' ? 'tokens-dark.css' : theme === 'base' ? 'tokens-base.css' : 'tokens-light.css'
  return path.join(getAppRoot(), 'packages', 'shared-ui-tokens', file)
}

export function normalizeTheme(theme: unknown): ThemePreference {
  return theme === 'dark' || theme === 'system' ? theme : 'light'
}

export function resolveTheme(theme: unknown, prefersDark = false): ResolvedTheme {
  const normalized = normalizeTheme(theme)
  return normalized === 'system' ? (prefersDark ? 'dark' : 'light') : normalized
}

/**
 * 收集扩展点 `theme.token-provider`（PART7 §7.3，MODE=REDUCE）产出的 CSS。
 *
 * ── 为什么主题要开放插槽 ────────────────────────────────────────────
 * 主题 token 目前来自 `packages/shared-ui-tokens/*.css` 三个文件 —— 编译期写死。
 * 插件/社区 Mod 想改配色、换字体、调间距就只能改内核文件，这正是 Harness 要消灭的事。
 * 打开这个插槽后：每个实现返回「一段要追加的 CSS」，串成流水线后附在 token 之后 ——
 * 后写的覆盖先写的（CSS 层叠语义天然就是"后注册的赢"）。
 *
 * ── 容错 ────────────────────────────────────────────────────────────
 * 插槽执行失败**不能**让整个主题加载失败（那会白屏）。这里降级为「没有额外样式」，
 * 并把原因打到控制台；调度器本身也已隔离了坏实现，这里是最后一道保险。
 */
async function collectExtensionTokenCss(extensionPoints: ExtensionPointsPort | null | undefined, theme: ThemeTokenName): Promise<string> {
  if (!extensionPoints || typeof extensionPoints.call !== 'function') return ''
  if (typeof extensionPoints.isDefined === 'function' && !extensionPoints.isDefined('theme.token-provider')) return ''
  try {
    const css = await extensionPoints.call('theme.token-provider', { theme })
    return typeof css === 'string' ? css.trim() : ''
  } catch (e) {
    const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
    console.warn('[theme] 扩展点 theme.token-provider 执行失败（已跳过）：', message)
    return ''
  }
}

/**
 * @param {string} theme
 * @param {{ extensionPoints?: object, overrides?: string }} [options]
 *   `extensionPoints` 扩展点调度器（可选；不传即纯文件 token）
 *   `overrides` **当前主题产出的令牌 CSS**（可选）。层叠顺序：
 *     token 文件（兜底默认） → overrides（主题） → 扩展点（社区 Mod）
 *   即"主题改的是配色、Mod 改的是最终样式" —— Mod 永远能盖住主题，
 *   而主题永远能盖住出厂默认。顺序调换都会让某一方"改了没反应"。
 */
export async function loadTokensCss(theme: unknown = 'light', options: ThemeLoadOptions = {}): Promise<string> {
  const t: ThemeTokenName = theme === 'dark' ? 'dark' : theme === 'base' ? 'base' : 'light'
  const base = await readText(getTokensPath('base'), { encoding: 'utf8' })
  const fileCss = t === 'base' ? base : `${base}\n${await readText(getTokensPath(t), { encoding: 'utf8' })}`
  const overrides = typeof options.overrides === 'string' ? options.overrides.trim() : ''
  const extra = await collectExtensionTokenCss(options.extensionPoints, t)
  return [fileCss, overrides, extra].filter(Boolean).join('\n')
}

export function createThemeManager({ initialTheme = 'light', prefersDark = false, extensionPoints = null }: ThemeManagerOptions = {}): ThemeManager {
  let current = normalizeTheme(initialTheme)
  let resolved = resolveTheme(current, prefersDark)
  /** 当前主题产出的令牌 CSS（见 loadTokensCss 的层叠顺序说明）。 */
  let overrides = ''
  const listeners = new Set<(theme: ThemePreference, resolved: ResolvedTheme, css: string) => void>()
  const applied = new WeakSet<object>()

  async function applyToWebContents(webContents: WebContentsThemePort | null | undefined): Promise<boolean> {
    if (!webContents || typeof webContents.insertCSS !== 'function') return false
    const css = await loadTokensCss(resolved, { extensionPoints, overrides })
    if (!css) return false
    await webContents.insertCSS(css)
    applied.add(webContents)
    return true
  }

  return {
    getTheme() {
      return current
    },
    getResolvedTheme(prefersDark) {
      return typeof prefersDark === 'boolean'
        ? resolveTheme(current, prefersDark)
        : resolved
    },
    /**
     * 切换主题。
     *
     * `prefersDark` 仍按两态（light/dark）解析 —— 主题系统里"跟随系统"是**调度**的一档，
     * 由调用方先解析成具体主题再进来，本处不承担调度语义（那是 theme-schedule 的事）。
     *
     * @param {string} next 'light' | 'dark'（其余一律回落 light）
     * @param {{ prefersDark?: boolean, overrides?: string }} [opts]
     */
    async setTheme(next: unknown, { prefersDark: nextPrefersDark = false, overrides: nextOverrides }: { prefersDark?: boolean; overrides?: string } = {}) {
      const preference = normalizeTheme(next)
      const nextResolved = resolveTheme(preference, nextPrefersDark)
      const hasOverrides = typeof nextOverrides === 'string'
      if (preference === current && nextResolved === resolved && !hasOverrides) return false
      current = preference
      resolved = nextResolved
      if (hasOverrides) overrides = nextOverrides
      const css = await loadTokensCss(resolved, { extensionPoints, overrides })
      listeners.forEach((cb) => cb(current, resolved, css))
      return true
    },
    onChange(cb: (theme: ThemePreference, resolved: ResolvedTheme, css: string) => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async applyToWebContents(webContents: WebContentsThemePort | null | undefined) {
      return applyToWebContents(webContents)
    },
    isApplied(webContents: object) {
      return applied.has(webContents)
    }
  }
}

export default {
  loadTokensCss,
  normalizeTheme,
  resolveTheme,
  createThemeManager
}

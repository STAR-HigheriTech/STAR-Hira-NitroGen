/**
 * theme-vivaldi.js —— Vivaldi 主题包 ↔ 我们主题包的**双向纯映射**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么值一个单独的文件
 * ══════════════════════════════════════════════════════════════════════
 * 映射是**纯数据搬运**：左侧是 Vivaldi 的字段名，右侧是我们的语义槽位。
 * 这种"两套命名对照"如果写进导入/导出流程里，会同时被两件事牵扯
 * （IO 的失败处理 + 字段名的偏移），最后谁都不敢改。
 * 分开之后：本文件零 IO、零依赖、不抛错 —— 可以在任何地方（含测试）直接用。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 映射口径
 * ══════════════════════════════════════════════════════════════════════
 *   Vivaldi                     我们                       说明
 *   ──────────────────────────  ─────────────────────────  ────────────────────────
 *   colorScheme.colorBg         colors.bg                 主背景
 *   colorScheme.colorFg         colors.fg                 主前景
 *   colorScheme.colorWindowBg   colors.surface            抬升表面（工具栏/窗口底）
 *   colorScheme.colorAccentBg   colors.accent             强调色
 *   colorScheme.colorHighlightBg colors.highlight         选中/高亮底
 *   α alpha（0~1）              style.transparency        工具栏透明层
 *   blur                        style.blur                UI 玻璃模糊
 *   contrast                    style.contrast            对比度增强
 *   cornerRadius                style.cornerRadius        圆角
 *   colorizeMode                style.colorizeMode        着色模式
 *   backgroundImage             background.path           包内相对路径
 *   backgroundPosition          background.position       'fill'/'fit'/'center'/'repeat'
 *
 * **模式（明/暗）不在 Vivaldi 的字段里** —— 它是由背景色推出来的。这里用
 * `readableTextOn`（WCAG 相对亮度）判"这个底色上该放深字还是浅字"，
 * 与旧 Hira 起始页自适配文字色是同一套判据，于是导入的浅色主题不会被打成暗色。
 *
 * ⚠ 单向兼容的诚实说明：**导出**写出的是 Vivaldi 认得的字段名（缺的字段不写），
 *   但 Vivaldi 自身版本的 schema 可能还要求别的键；本文件不假装能保证"Vivaldi
 *   一定能原样打开"，只保证"字段名与语义对得上、且我们自己的导入能原样读回"。
 *   Vivaldi 里没对应物的槽位（每日图 / 桌面壁纸）在导出时降级为纯色。
 */

import { relativeLuminance, clamp01, COLORIZE_MODES, DEFAULT_STYLE } from '@hira-ng/shared-types/src/theme.mjs'

interface VivaldiImportOptions { id?: string; name?: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

export const OUR_POSITION_FROM_VIVALDI: Readonly<Record<string, string>> = Object.freeze({
  fill: 'cover',
  fit: 'contain',
  center: 'center',
  repeat: 'tile',
  stretch: 'stretch',
  cover: 'cover',
  contain: 'contain',
  tile: 'tile'
})

export const VIVALDI_POSITION_FROM_OURS: Readonly<Record<string, string>> = Object.freeze({
  cover: 'fill',
  contain: 'fit',
  center: 'center',
  tile: 'repeat',
  stretch: 'stretch'
})

/** 颜色：非字符串或空 → `''`（调用方据此走派生值，而不是塞一个脏值进主题）。 */
function color(value: unknown): string {
  const raw = value == null ? '' : String(value).trim()
  return raw
}

/**
 * 这份 JSON 看起来是不是一个 Vivaldi 主题包。
 *
 * 判据只挑**它独有**的键：`colorScheme` 是 Vivaldi 的主题核心字段，
 * 而我们自己的 theme.json 从不用这个键名 —— 于是"是我们格式还是 Vivaldi 格式"
 * 不需要靠猜，也不会把我们的包误判成 Vivaldi（反之亦然）。
 */
export function looksLikeVivaldi(json: unknown): boolean {
  const record = asRecord(json)
  if (!record) return false
  const scheme = record.colorScheme || record.darkColorScheme || record.lightColorScheme
  return !!scheme && typeof scheme === 'object'
}

/** 该主题是否偏暗（由背景色的相对亮度决定）。 */
function isDarkScheme(bg: string, fgHint: unknown): boolean {
  if (bg) return relativeLuminance(bg) < 0.5
  // 没有背景色时退回看前景：浅字通常意味着暗底
  if (fgHint) return relativeLuminance(fgHint) > 0.5
  return false
}

/**
 * Vivaldi 主题 JSON → 我们的主题定义（**未归一化的原始对象**，交给 `normalizeTheme` 收口）。
 *
 * @param {any} json Vivaldi 的 theme.json 内容
 * @param {{ id?: string, name?: string }} [opts] id 由调用方给（唯一性只有它知道）
 * @returns {object|null} 不是可识别的 Vivaldi 主题 → null
 */
export function fromVivaldi(json: unknown, opts: VivaldiImportOptions = {}): Record<string, unknown> | null {
  if (!looksLikeVivaldi(json)) return null
  const record = asRecord(json) || {}
  const scheme = asRecord(record.colorScheme) || asRecord(record.darkColorScheme) || asRecord(record.lightColorScheme) || {}
  const bg = color(scheme.colorBg)
  const fg = color(scheme.colorFg)

  const colors: Record<string, string> = {
    bg,
    fg,
    surface: color(scheme.colorWindowBg) || color(scheme.colorBg),
    accent: color(scheme.colorAccentBg),
    highlight: color(scheme.colorHighlightBg),
    border: ''
  }
  // 丢掉空槽位：让 `derivePalette` 去补（作者没给的颜色不该被写成空串）
  for (const key of Object.keys(colors)) if (!colors[key]) delete colors[key]

  const bgImage = color(record.backgroundImage)
  const position = OUR_POSITION_FROM_VIVALDI[String(record.backgroundPosition || '').toLowerCase()] || 'cover'

  return {
    id: String(opts.id || ''),
    name: String(opts.name || record.name || 'Vivaldi 主题'),
    author: color(record.author),
    version: color(record.version),
    mode: isDarkScheme(bg, fg) ? 'dark' : 'light',
    colors,
    style: {
      transparency: numberOr(record.alpha, 0),
      blur: numberOr(record.blur, 0),
      contrast: numberOr(record.contrast, 0),
      cornerRadius: 6, // Vivaldi 的 cornerRadius 与我们的单位/口径未必一致，不猜
      colorizeMode: colorize(record.colorizeMode)
    },
    background: bgImage
      ? {
          kind: 'image',
          path: bgImage,
          color: bg,
          position,
          opacity: 1,
          blur: 0,
          overlay: 0,
          overlayColor: '',
          applyTo: ['window', 'newtab']
        }
      : { kind: bg ? 'color' : 'none', color: bg, applyTo: ['window', 'newtab'] },
    icons: {},
    preview: color(record.preview) || null
  }
}

/**
 * 我们的主题 → Vivaldi 认得的 JSON。
 *
 * 用**归一化后的主题对象**（`normalizeTheme` 的产物）：那样颜色已经是 `#rrggbb`
 * 或 `rgba(...)`，不需要在这里再处理一遍格式。
 *
 * @param {any} theme
 * @returns {object}
 */
export function toVivaldi(theme: unknown): Record<string, unknown> {
  const t = asRecord(theme) || {}
  const colors = asRecord(t.colors) || {}
  const style = asRecord(t.style) || {}
  const bg = asRecord(t.background) || {}

  const out: Record<string, unknown> = {
    version: 1,
    name: t.name || t.id || 'Hira 主题',
    author: t.author || '',
    colorScheme: {
      colorBg: colors.bg || '',
      colorFg: colors.fg || '',
      colorWindowBg: colors.surface || colors.solid || '',
      colorAccentBg: colors.accent || '',
      colorAccentFg: colors.onAccent || '',
      colorHighlightBg: colors.highlight || '',
      colorHighlightFg: colors.onAccent || ''
    },
    /**
     * Vivaldi 的 `alpha` 是"透明层"（1 = 完全透明）；我们的 `chromeOverlay` 是
     * **不透明度**（1 = 完全挡住）。显式声明过就按它换算（否则导出的包与我们在界面上
     * 看到的不透明度对不上）；没声明过就原样带走 `transparency`，不做有损改写。
     */
    alpha: (style.chromeOverlay != null)
      ? Number((1 - clamp01(style.chromeOverlay)).toFixed(3))
      : numberOr(style.transparency, 0),
    blur: numberOr(style.blur, 0),
    contrast: numberOr(style.contrast, 0),
    cornerRadius: numberOr(style.cornerRadius, 6),
    colorizeMode: colorize(style.colorizeMode)
  }

  // 只有"图片"背景在 Vivaldi 里有对应物；纯色/渐变/**视频**/每日图/桌面壁纸导出时
  // 降级为只有配色（`colorBg` 已经承载了那份底色），不写 backgroundImage。
  // ⚠ 视频背景**故意**不往这里写：Vivaldi 的 `backgroundImage` 语义是一张位图，
  // 塞一段 mp4 进去在对方那儿只会加载失败。主题包里的 `theme.json`（我们自己的格式）
  // 完整带着 `kind:'video'` 与那个文件，所以**导回来仍然是对的** —— 丢的只是
  // "顺手能丢给 Vivaldi 试"的那一半能力，这一点在 §6.4 里写明了。
  if (bg.kind === 'image' && bg.path) {
    out.backgroundImage = String(bg.path)
    out.backgroundPosition = VIVALDI_POSITION_FROM_OURS[String(bg.position || '')] || 'fill'
  }
  return out
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function colorize(value: unknown): string {
  const v = String(value || '')
  return COLORIZE_MODES.includes(v) ? v : DEFAULT_STYLE.colorizeMode
}


/**
 * theme-builtins.js —— 内置主题目录（**纯数据**：配色字面量 + 一条材质派生工厂）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么内置主题是"数据文件"而不是"内置插件"
 * ══════════════════════════════════════════════════════════════════════
 * 主题插件（`type: theme-plugin`）解决的是**分发**问题：安装 / 启停 / 卸载 / 市场 / 签名。
 * 但界面**任何时候都需要一套可读的默认配色** —— 插件体系整体起不来时（首次启动、
 * 插件目录损坏、全部被禁用），如果"默认主题"也来自插件，用户看到的就是一片没有颜色的裸 DOM。
 * 这与 `panel-catalog.js#FALLBACK_PANELS` 是同一条理由，所以这里与它同构：
 * **内置主题写死在代码里，插件主题再叠上来。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么颜色给得这么"满"
 * ══════════════════════════════════════════════════════════════════════
 * 令牌映射（`shared-types/src/theme.mjs#themeToTokens`）在作者**没给**某个色值时
 * 会按 `bg/fg/accent` 推导（`mix(fg, bg, t)` 那一套）。推导出来的值好看，但**不等于**
 * 改造前 `tokens-*.css` 里的那些精确取值（例如 `--hira-bg-elevated` 是 #f7f9fc 这种
 * 带一点蓝的抬升面，推不出来）。
 * 于是内置主题把**已知的每一档都显式写出来** → 装上主题系统后，默认观感与改造前逐值一致
 * （UI 像素冻结那条约束），而第三方主题只写三个色也能看。
 * 两条路走同一个出口：`colors` 里有这个键就用，没有才推导。
 *
 * 字段口径见 `docs-ng/主题系统设计.md` §2；取值来源：
 *   packages/shared-ui-tokens/tokens-base.css · tokens-dark.css · tokens-light.css
 *   apps/app-main/src/pages/_shared/base.css
 */

import { BUILTIN_THEME_IDS } from '@hira-ng/shared-types/src/theme.mjs'

export interface BuiltinTheme {
  id: string
  name: Record<string, string>
  author: string
  version: string
  schemaVersion: number
  source: string
  mode: string
  colors: Record<string, string>
  style: Record<string, unknown>
  background: Record<string, unknown>
  [key: string]: unknown
}

interface MaterialVariantSpec {
  id: string
  zh: string
  en: string
  material: 'acrylic' | 'mica'
  cornerRadius?: number
  chromeOverlay?: number
  panelOverlay?: number
}

/** 内置主题 id —— 与 shared-types 的 `BUILTIN_THEME_IDS` 同源（顺序即 [浅色, 深色]）。 */
export const HIRA_LIGHT_ID = String(BUILTIN_THEME_IDS[0] || '')
export const HIRA_DARK_ID = String(BUILTIN_THEME_IDS[1] || '')

/**
 * 浅色母版。
 *
 * 「亚克力 / Mica」两类**窗口材质预设都由它与 `HIRA_DARK` 派生**（`materialVariant`）：
 * 配色逐值相同，唯一差异是 `style.material`。
 */
const HIRA_LIGHT: BuiltinTheme = {
  id: HIRA_LIGHT_ID,
  name: { 'zh-CN': '浅色', 'en-US': 'Light' },
  author: 'Hira',
  version: '1.0.0',
  schemaVersion: 1,
  source: 'builtin',
  mode: 'light',
  colors: {
    bg: '#f9fafb',
    fg: '#1a1a1a',
    surface: '#f7f9fc',
    solid: '#ffffff',
    bgSubtle: '#f3f4f6',
    surfaceSoft: 'rgba(0, 0, 0, 0.04)',
    hover: 'rgba(0, 0, 0, 0.05)',
    field: 'rgba(0, 0, 0, 0.04)',
    fieldFocus: 'rgba(0, 0, 0, 0.05)',
    track: 'rgba(0, 0, 0, 0.1)',
    border: 'rgba(0, 0, 0, 0.1)',
    borderStrong: '#c4c4c4',
    textSoft: '#6b7280',
    textMuted: '#9ca3af',
    accent: '#3b82f6',
    accentHover: '#2563eb',
    accentSoft: 'rgba(59, 130, 246, 0.12)',
    danger: '#dc2626',
    dangerBg: 'rgba(220, 38, 38, 0.08)',
    warn: '#d97706',
    warnBg: 'rgba(245, 158, 11, 0.12)',
    onAccent: '#ffffff'
  },
  style: { transparency: 0, blur: 0, contrast: 0, cornerRadius: 6, colorizeMode: 'unified' },
  background: { kind: 'none', applyTo: ['window', 'newtab'] }
}

/** 深色母版。同样由材质预设派生（见 `materialVariant`）。 */
const HIRA_DARK: BuiltinTheme = {
  id: HIRA_DARK_ID,
  name: { 'zh-CN': '深色', 'en-US': 'Dark' },
  author: 'Hira',
  version: '1.0.0',
  schemaVersion: 1,
  source: 'builtin',
  mode: 'dark',
  colors: {
    bg: '#1e1e1e',
    fg: '#e0e0e0',
    /**
     * 深色的"实心控件面"与抬升面同值（#2a2a2a）—— 这是 tokens-dark.css 里
     * 刻意做过的决定：深色下实心底**不能**照搬浅色的 #fff，否则下拉、输入框全是白块。
     */
    surface: '#2a2a2a',
    solid: '#2a2a2a',
    bgSubtle: 'rgba(255, 255, 255, 0.05)',
    surfaceSoft: 'rgba(255, 255, 255, 0.06)',
    /**
     * hover 深色取 .10 而不是浅色那档 .05：白叠黑的对比步进比黑叠白弱得多，
     * .05 在 #1e1e1e 上只抬约 12 个灰阶 —— 观感就是"没有 hover 反馈"。
     */
    hover: 'rgba(255, 255, 255, 0.1)',
    field: 'rgba(255, 255, 255, 0.1)',
    fieldFocus: 'rgba(255, 255, 255, 0.16)',
    track: 'rgba(255, 255, 255, 0.14)',
    border: 'rgba(255, 255, 255, 0.1)',
    borderStrong: '#4a4a4a',
    textSoft: '#888888',
    /** 深色下三级文本必须**暗于**二级（#888），否则层级读反。 */
    textMuted: '#7b8188',
    accent: '#0a84ff',
    accentHover: '#409cff',
    accentSoft: 'rgba(10, 132, 255, 0.22)',
    danger: '#ff6b6b',
    dangerBg: 'rgba(255, 107, 107, 0.16)',
    warn: '#f5a524',
    warnBg: 'rgba(245, 165, 36, 0.16)',
    onAccent: '#ffffff'
  },
  style: { transparency: 0, blur: 0, contrast: 0, cornerRadius: 6, colorizeMode: 'unified' },
  background: { kind: 'none', applyTo: ['window', 'newtab'] }
}

/**
 * 由母版派生一条「窗口材质」预设。
 *
 * 这类预设的卖点是**材质**（窗口直接透出桌面 / 壁纸的模糊），配色若也跟着变，
 * 用户就分不清"这是材质的效果"还是"我换了配色"。所以它与母版**逐值相同**，
 * 差异只有 `style.material`、略大的圆角（玻璃边略大更贴近 Win11 观感），
 * 以及 spec 显式给出的遮罩不透明度（目前只有两份 Mica 钉了 0%，见下面那条注释）。
 *
 * 为什么要工厂而不是把四份字面量各抄一遍：手抄的配色只要有一份忘了改，
 * "切换预设时画面上只有材质在变"这条不变式就悄悄破了。母版改一处，全部材质预设同时跟上。
 *
 * `background.kind` 固定 `none`：材质与壁纸是两条路（见 `theme.mjs#glassSurface`）——
 * 壁纸是"自己画一层在窗口里"，会把 DWM 的系统模糊盖住；这里要的是后者。
 *
 * `chromeOverlay` / `panelOverlay` 可**显式**钉住遮罩不透明度：`0` 是有效值（完全透出
 * 窗口材质），所以判据必须是 `!= null`，不能用 `||` 兜底成母版值 —— 否则"0%"会被
 * 静默吃掉，用户看到的就是"改了没反应"。
 *
 * @param {object} base 母版主题（`HIRA_LIGHT` / `HIRA_DARK`）
 * @param {{ id: string, zh: string, en: string, material: 'acrylic'|'mica', cornerRadius?: number, chromeOverlay?: number, panelOverlay?: number }} spec
 */
function materialVariant(base: BuiltinTheme, spec: MaterialVariantSpec): BuiltinTheme {
  const style: Record<string, unknown> = { ...base.style, cornerRadius: spec.cornerRadius || 8, material: spec.material }
  if (spec.chromeOverlay != null) style.chromeOverlay = spec.chromeOverlay
  if (spec.panelOverlay != null) style.panelOverlay = spec.panelOverlay
  return {
    ...base,
    id: spec.id,
    name: { 'zh-CN': spec.zh, 'en-US': spec.en },
    // 逐值复制而非共享引用：母版与派生主题各自独立，编辑草稿不会互相牵连
    colors: { ...base.colors },
    style,
    background: { ...base.background }
  }
}

/** 内置主题数组。`source: 'builtin'` 让 UI 知道它们不可删除、不可覆盖。 */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = Object.freeze([
  HIRA_LIGHT,
  HIRA_DARK,
  /** 亚克力（Win10 同款实时反光）：窗口后方实时模糊，颜色跟随母版。 */
  materialVariant(HIRA_LIGHT, { id: 'hira-acrylic-light', zh: '亚克力浅', en: 'Acrylic Light', material: 'acrylic' }),
  materialVariant(HIRA_DARK, { id: 'hira-acrylic-dark', zh: '亚克力深', en: 'Acrylic Dark', material: 'acrylic' }),
  /**
   * Mica（Win11 同款）：DWM 把桌面壁纸糊一层垫在窗口后面，比亚克力更"静"。
   *
   * 两份 Mica 的 **UI 遮罩不透明度钉在 0%**（用户要求）：Mica 的卖点就是那层系统材质
   * 本身，再压一层 55% 的主题色等于把材质盖掉一半。面板遮罩则**显式钉住**（不让它
   * 跟随 UI 遮罩一起归零）—— 面板是独立视图、盖在网页之上，全透会直接读不清；
   * 取值用 format.js 里材质推荐值 mica.panelOverlay（0.6）。
   */
  materialVariant(HIRA_LIGHT, { id: 'hira-mica-light', zh: 'Mica 浅', en: 'Mica Light', material: 'mica', chromeOverlay: 0, panelOverlay: 0.6 }),
  materialVariant(HIRA_DARK, { id: 'hira-mica-dark', zh: 'Mica 深', en: 'Mica Dark', material: 'mica', chromeOverlay: 0, panelOverlay: 0.6 }),
  {
    /**
     * 极光暗 —— **第一个带背景图层的主题**，也是"背景管线"的活体验收样例：
     * 它用 `kind: 'css'`（一个渐变）而不是打包一张图片，于是内置主题不需要携带二进制，
     * 而"背景层 / 模糊 / 遮罩 / 应用到窗口与新标签页"这整条链路照样被真实走到。
     */
    id: 'hira-aurora-dark',
    name: { 'zh-CN': '极光暗', 'en-US': 'Aurora Dark' },
    author: 'Hira',
    version: '1.0.0',
    schemaVersion: 1,
    source: 'builtin',
    mode: 'dark',
    colors: {
      bg: '#0d1b2a',
      fg: '#e3ecf5',
      surface: '#132436',
      solid: '#16293d',
      bgSubtle: 'rgba(255, 255, 255, 0.05)',
      surfaceSoft: 'rgba(255, 255, 255, 0.06)',
      hover: 'rgba(255, 255, 255, 0.1)',
      field: 'rgba(255, 255, 255, 0.1)',
      fieldFocus: 'rgba(255, 255, 255, 0.16)',
      track: 'rgba(255, 255, 255, 0.14)',
      border: 'rgba(255, 255, 255, 0.12)',
      borderStrong: '#2f4a63',
      textSoft: '#9db4c8',
      textMuted: '#7d94a8',
      accent: '#22d3ee',
      accentHover: '#67e8f9',
      accentSoft: 'rgba(34, 211, 238, 0.2)',
      danger: '#ff6b6b',
      dangerBg: 'rgba(255, 107, 107, 0.16)',
      warn: '#f5a524',
      warnBg: 'rgba(245, 165, 36, 0.16)',
      onAccent: '#06202a'
    },
    /**
     * 工具栏半透 + 模糊：背景要"从 UI 里透出来"才像主题，而不是"桌面贴了一张图、
     * 上面盖着一条不透明的条"。这两个数正是 Vivaldi 主题的 Transparency / Blur 两项。
     */
    style: { transparency: 0.55, blur: 18, contrast: 0, cornerRadius: 10, colorizeMode: 'unified' },
    background: {
      kind: 'css',
      css: 'linear-gradient(155deg, #06121f 0%, #0b2233 38%, #10405a 68%, #0a1b2b 100%)',
      position: 'cover',
      opacity: 1,
      blur: 0,
      overlay: 0.28,
      overlayColor: '#04101c',
      applyTo: ['window', 'newtab']
    }
  },
  {
    /**
     * 樱花浅 —— 把 tokens-light.css 里**已存在但不可达**的 `sakura` 预设
     * 复活成一个真主题（那份文件里还有 mint / warmGray 两套同类的死规则）。
     * 主题系统一上来要能装下"同一个模式下的多个配色变体"，这个主题就是那条能力的样例。
     */
    id: 'hira-sakura-light',
    name: { 'zh-CN': '樱花浅', 'en-US': 'Sakura Light' },
    author: 'Hira',
    version: '1.0.0',
    schemaVersion: 1,
    source: 'builtin',
    mode: 'light',
    colors: {
      bg: '#fff1f5',
      fg: '#3d2530',
      surface: '#fff7f9',
      solid: '#ffffff',
      bgSubtle: '#fde8ee',
      surfaceSoft: 'rgba(61, 37, 48, 0.04)',
      hover: 'rgba(61, 37, 48, 0.05)',
      field: 'rgba(61, 37, 48, 0.04)',
      fieldFocus: 'rgba(61, 37, 48, 0.06)',
      track: 'rgba(61, 37, 48, 0.1)',
      border: 'rgba(244, 114, 182, 0.28)',
      borderStrong: 'rgba(236, 72, 153, 0.42)',
      textSoft: '#8a6273',
      textMuted: '#b092a0',
      accent: '#ec4899',
      accentHover: '#db2777',
      accentSoft: 'rgba(236, 72, 153, 0.12)',
      danger: '#dc2626',
      dangerBg: 'rgba(220, 38, 38, 0.08)',
      warn: '#d97706',
      warnBg: 'rgba(245, 158, 11, 0.12)',
      onAccent: '#ffffff'
    },
    style: { transparency: 0.18, blur: 8, contrast: 0, cornerRadius: 12, colorizeMode: 'unified' },
    background: {
      kind: 'css',
      css: 'radial-gradient(120% 90% at 12% 0%, #ffe4ec 0%, #fff1f5 46%, #fdf2ff 100%)',
      position: 'cover',
      opacity: 1,
      blur: 0,
      overlay: 0,
      overlayColor: '#fff1f5',
      // 壁纸只有窗口级那一份（新标签页透明透出它），所以这里必须同时含 window：
      // 只写 newtab 的主题在归一化里也会被补成 window（见 normalizeThemeBackground）。
      applyTo: ['window', 'newtab']
    }
  }
])

/**
 * 按 id 取内置主题；未命中返回 null（调用方据此回落第一个内置主题）。
 * @param {string} id
 */
export function findBuiltinTheme(id: unknown): BuiltinTheme | null {
  const key = String(id == null ? '' : id)
  return BUILTIN_THEMES.find((t) => t.id === key) || null
}


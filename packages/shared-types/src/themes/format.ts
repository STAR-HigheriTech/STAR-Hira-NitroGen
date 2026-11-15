/**
 * shared/format.js —— 主题 UI 的**纯数据层**（零 DOM、零 IPC、零状态）。
 *
 * 这里只放"把主题数据翻译成界面要用的事实"这件事：
 *   · 来源分组与文案（内置 / 自建 / 插件）
 *   · 卡片预览怎么画（配色条 / 渐变底）
 *   · 编辑器有哪些槽位、滑杆区间、下拉选项
 *   · `<input type=color>` 只吃 `#rrggbb`，而主题里可能是 `rgba(...)` → 转换
 *
 * 为什么单独一层：**两个形态（窄面板 / 主题页）都要这些事实**。
 * 写进各自视图里就会出现"面板里显示'插件'、窗口里显示'plugin'"这类漂移；
 * 而这些全是纯函数，也最容易在改动时保持正确。
 */

/**
 * 枚举 id 一律来自 `shared-types/src/theme.mjs`（**唯一真源**）：
 * 本文件只负责给每个 id 配中文文案与界面顺序，不再手抄第二份 id 数组。
 * 改造前 `SOURCE_ORDER` / `SCHEDULE_MODES` / `BACKGROUND_KINDS` … 都是字面量，
 * 真源加一档、这里就漏一档（表现是"存进去了，下拉里没有"）。
 */
import {
  THEME_SOURCES,
  THEME_MODES,
  THEME_SCHEDULE_MODES,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
  normalizeThemeMode,
  themeModeLabel,
  COLORIZE_MODES as COLORIZE_MODE_IDS,
  WINDOW_MATERIALS as WINDOW_MATERIAL_IDS,
  WINDOW_MATERIAL_LABELS,
  BACKGROUND_KINDS as BACKGROUND_KIND_IDS,
  BACKGROUND_POSITIONS as BACKGROUND_POSITION_IDS,
  BACKGROUND_APPLY_TARGETS as BACKGROUND_APPLY_TARGET_IDS,
  AUTO_FG,
  AUTO_FG_KEYS,
  MIN_UI_BLUR
} from '../theme.js'

/** 来源 → 分组标题。顺序即库里的显示顺序（内置在最前，与设置页下拉一致）。 */
export const SOURCE_ORDER = THEME_SOURCES

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  builtin: '内置',
  user: '我的主题',
  plugin: '插件主题'
}

/** 一条主题的来源（主进程已归一化，这里只兜底）。 */
export function sourceOf(theme: ThemeSummary | null | undefined): string {
  const s = theme && typeof theme.source === 'string' ? theme.source : ''
  return SOURCE_ORDER.indexOf(s) >= 0 ? s : 'plugin'
}

/**
 * 按来源分组（丢掉空组）。
 * @param {any[]} themes
 * @returns {{ source: string, label: string, themes: any[] }[]}
 */
export interface ThemeSummary {
  id?: string
  name?: string
  source?: string
  mode?: string
  swatch?: Record<string, string>
  background?: { kind?: string; css?: string; color?: string }
  [key: string]: unknown
}

export function groupThemes(themes: readonly ThemeSummary[]) {
  const list = Array.isArray(themes) ? themes : []
  return SOURCE_ORDER
    .map((source) => ({ source, label: SOURCE_LABELS[source], themes: list.filter((t) => sourceOf(t) === source) }))
    .filter((g) => g.themes.length > 0)
}

/** 模式 → 展示文案（文案真源在 `theme.mjs#THEME_MODE_LABELS`，这里只转发）。 */
export function modeLabel(mode: unknown): string {
  return themeModeLabel(normalizeThemeMode(mode))
}

/** 明暗两档（id 来自真源，文案同上）—— 编辑器分段控件用，不另抄一份 id/文案。 */
export const THEME_MODE_OPTIONS = THEME_MODES.map((value) => ({ value, label: modeLabel(value) }))

/**
 * 卡片的底：优先用主题自己的背景（`kind:'css'` 的渐变最有辨识度），
 * 否则用三档配色拼一条对角线渐变 —— **每张卡都要有可区分的画面**，
 * 一排灰底卡片等于没有预览。
 */
export function swatchBackground(theme: ThemeSummary | null | undefined): string {
  const bg = (theme && theme.background) || {}
  const s = (theme && theme.swatch) || {}
  if (bg.kind === 'css' && bg.css) return bg.css
  if (bg.kind === 'color' && bg.color) {
    return `linear-gradient(135deg, ${bg.color} 0%, ${bg.color} 45%, ${s.accent || bg.color} 100%)`
  }
  const stops = [s.bg || '#1f2430', s.surface || s.bg || '#2a3040', s.accent || '#5b9bff']
  return `linear-gradient(135deg, ${stops[0]} 0%, ${stops[1]} 55%, ${stops[2]} 100%)`
}

/** 配色条上的四格（缺色时用透明占位，条不会塌）。 */
export function swatchStrip(theme: ThemeSummary | null | undefined): unknown[] {
  const s = (theme && theme.swatch) || {}
  return [s.bg, s.surface, s.accent, s.fg].map((c) => c || 'transparent')
}

// ══════════════════════════════════════════════════════════════════════
// 编辑器槽位（唯一声明处：表单按这份数据生成，不手写六遍同样的行）
// ══════════════════════════════════════════════════════════════════════

/** 颜色槽位 —— 与 `theme.mjs#derivePalette` 读取的键**逐字对应**。 */
export const COLOR_FIELDS = [
  { key: 'bg', label: '背景', hint: '主背景色（colorBg）' },
  { key: 'fg', label: '前景', hint: '正文与图标（colorFg）' },
  /**
   * UI 前景：**只**作用于浏览器 chrome（navbar / tabbar / rail 及其组件），
   * 不动网页内容与内部页（设置 / 历史 / 下载…）—— 后者读的是 `colors.fg`。
   * 面板与侧栏网页标题栏各有自己的一档（下面两条），未设时跟随它。
   * 留空 = 跟随「前景」。
   *
   * 这三档都可以取哨兵 `auto`（按壁纸明暗自动选黑/白）—— 但**由编辑器那个总开关**
   * 一次写三档（见 anyForegroundAuto），不在这里逐行给开关。
   */
  { key: 'chromeFg', label: 'UI 前景', hint: '工具栏/标签栏/rail' },
  /** 面板（下载 / 历史 / 书签…）里的文字与图标；留空 = 跟随 UI 前景。 */
  { key: 'panelFg', label: '面板前景', hint: '面板里的字与图标，默认同 UI 前景' },
  /** 独立侧栏（网页浏览）顶部标题栏的文字与按钮；留空 = 跟随 UI 前景。 */
  { key: 'webSidebarFg', label: '侧栏网页标题栏前景', hint: '那一栏的标题/域名/按钮，默认同 UI 前景' },
  { key: 'surface', label: '表面', hint: '工具栏 / 面板 / 卡片' },
  { key: 'accent', label: '强调', hint: '主按钮与选中态（colorAccentBg）' },
  { key: 'highlight', label: '高亮', hint: '选中背景（colorHighlightBg）' },
  { key: 'border', label: '边框', hint: '分隔线与描边' }
]

/**
 * 外观滑杆（区间与 `normalizeTheme` 的夹取范围一致）。
 *
 * `group` 决定它归在编辑器哪一块：
 *   · `material` —— 「材质与玻璃」：染色浓度 / 面板浓度 / UI 层模糊，
 *                   **原生材质没有染色与透明度参数**，观感全靠这三根（+ 遮罩色）；
 *   · `shape`    —— 其余外观项（对比度 / 圆角）。
 * 分组是**数据**而不是视图里的 if：将来加一根玻璃参数，只在这里标一格。
 */
export const STYLE_SLIDERS = [
  { key: 'chromeOverlay', group: 'material', label: 'UI 遮罩不透明度', hint: '只影响工具栏', min: 0, max: 100, step: 1, unit: '%', scale: 100 },
  { key: 'panelOverlay', group: 'material', label: '面板遮罩不透明度', hint: '只作用于面板，叠在 UI 遮罩之上', min: 0, max: 100, step: 1, unit: '%', scale: 100 },
  // 这是**UI 玻璃层**的下限，不约束背景图本身；壁纸模糊见 BACKGROUND_SLIDERS。
  { key: 'blur', group: 'material', label: 'UI 模糊', hint: `只作用于 UI 玻璃层，最小 ${MIN_UI_BLUR}px`, min: MIN_UI_BLUR, max: 60, step: 1, unit: 'px', scale: 1 },
  { key: 'contrast', group: 'shape', label: '对比度', min: 0, max: 100, step: 1, unit: '%', scale: 100 },
  { key: 'cornerRadius', group: 'shape', label: '圆角', hint: '0 = 直角；网页 / 面板 / 标签 / 浮层一起变', min: 0, max: 24, step: 1, unit: 'px', scale: 1 },
  { key: 'contentInset', group: 'shape', label: '视图边距', hint: '网页 / 面板与工具栏之间的空隙，0 = 贴边无边框', min: 0, max: 16, step: 1, unit: 'px', scale: 1 }
]

/**
 * 着色模式文案（id 来自真源，这里只配名字）。
 *
 * 只剩 `unified` 一档（见 `theme.mjs#COLORIZE_MODES`）：本项目只有一套主题色，
 * 「标签栏 / 地址栏」那两档没有实现、也没有消费者，摆出来就是假选项。
 */
const COLORIZE_MODE_LABELS: Readonly<Record<string, string>> = {
  unified: '全部统一着色'
}

/**
 * 窗口材质（系统级模糊）选项 —— id 与文案**都来自真源**
 * （`shared-types#WINDOW_MATERIALS` / `WINDOW_MATERIAL_LABELS`），这里只排顺序。
 * 文案放真源而不是这里：主进程回退提示要引用同一批名字，两处各写一份迟早不一致。
 */
export const WINDOW_MATERIALS = WINDOW_MATERIAL_IDS.map((value) => ({
  value,
  label: (WINDOW_MATERIAL_LABELS as Readonly<Record<string, string>>)[value] || value
}))

/**
 * 选了窗口材质、但这台机器给不出来时的提示。
 *
 * 为什么必须说出来：`setBackgroundMaterial` 在 Win10 / 非 Windows 上是**静默无效**的
 * （Electron 直接 return，不报错），用户只会看到"选了亚克力，窗口还是实心的"。
 * 与其让人怀疑是 bug，不如直说"会回退成染色玻璃"。
 */
export const WINDOW_MATERIAL_UNSUPPORTED_HINT =
  '当前系统不支持系统级模糊（需要 Windows 11 22H2 及以上），窗口会回退为染色玻璃'

/**
 * 主题卡片上的材质角标（**短名**）。
 *
 * 为什么要单独一档短名：`WINDOW_MATERIAL_LABELS` 是给下拉框的完整文案
 * （"亚克力（窗口后方实时模糊）"），塞进 62px 高的卡片角标里会挤成一整行。
 * 与 `COLORIZE_MODE_LABELS` 同一条分工：id 来自真源，界面短名留在界面层。
 */
const MATERIAL_BADGES: Readonly<Record<string, string>> = { acrylic: '亚克力', mica: 'Mica' }

/**
 * 材质 → 卡片角标文案；`none` / 未知材质返回空串（调用方据此决定画不画角标）。
 *
 * 为什么卡片必须标出来：亚克力预设的配色与基础浅色/深色**逐值相同**，
 * 只靠配色条与渐变底，库里根本分不出哪张是"窗口透桌面"的那张。
 * @param {string} [material]
 */
export function materialBadge(material: string): string {
  return MATERIAL_BADGES[material] || ''
}

/**
 * 每种材质一句话解释（编辑器「材质与玻璃」里常驻显示）。
 *
 * 为什么非要有：两个原生材质在 Win11 上肉眼差别很细（一个糊窗口后方、一个糊桌面壁纸），
 * 只靠名字用户没法选。这里说清"它糊的是什么、观感更透还是更实"。
 */
const MATERIAL_HINTS: Readonly<Record<string, string>> = {
  none: '不启用系统材质：窗口保持不透明，玻璃效果只来自壁纸与染色。',
  acrylic: '亚克力：窗口后方的内容实时模糊，最透、最"磨砂"；染色淡一点更容易看出模糊。',
  mica: 'Mica：模糊的是桌面壁纸（静态、更克制），更接近 Windows 11 原生观感。'
}

/**
 * 材质 → 说明文案（未知材质按 `none` 说明）。
 * @param {string} [material]
 */
export function materialHint(material: string): string {
  return MATERIAL_HINTS[material] || MATERIAL_HINTS.none
}

/**
 * 每种材质的**推荐染色 / 模糊**（编辑器「套用推荐值」一次写入这三个键）。
 *
 * 为什么只给浓度不给颜色：染色色默认跟随主题底色（`resolveChromeOverlayColor`），
 * 硬写一个色会在浅色主题上变成脏污；浓度与模糊才是"材质 ↔ 玻璃"真正要配平的量。
 *   · 亚克力本身糊得厉害 → 染色薄、UI 模糊大一点，让玻璃层透出来；
 *   · Mica 是静态壁纸模糊，观感更"实" → 染色厚一点；UI 模糊减半，
 *     避免"我们的 CSS 模糊"与"系统的 Mica 模糊"叠成一片糊。
 */
export const MATERIAL_RECOMMENDED: Readonly<Record<string, Readonly<{ chromeOverlay: number; panelOverlay: number; blur: number }>>> = Object.freeze({
  acrylic: Object.freeze({ chromeOverlay: 0.28, panelOverlay: 0.5, blur: 20 }),
  mica: Object.freeze({ chromeOverlay: 0.42, panelOverlay: 0.6, blur: 10 })
})

/**
 * 某材质是否有"推荐值"可套（`none` 没有 —— 没材质就没有要配平的玻璃）。
 * @param {string} [material]
 */
export function hasMaterialTuning(material: string): boolean {
  return !!MATERIAL_RECOMMENDED[material]
}

export const COLORIZE_MODES = COLORIZE_MODE_IDS.map((value) => ({
  value,
  label: COLORIZE_MODE_LABELS[value] || value
}))

/** 背景种类文案（id 来自真源）。 */
const BACKGROUND_KIND_LABELS: Readonly<Record<string, string>> = {
  none: '无（仅主题色）',
  color: '纯色',
  css: '渐变 / CSS',
  image: '图片',
  // 动态壁纸：与图片同一条链（选文件 → 拷进资产库），画法不同（<video> 而不是 background-image）
  video: '视频（动态壁纸）',
  daily: '每日一图',
  desktop: '桌面壁纸'
}

export const BACKGROUND_KINDS = BACKGROUND_KIND_IDS.map((value) => ({
  value,
  label: BACKGROUND_KIND_LABELS[value] || value
}))

/**
 * 「按壁纸自动分析前景」对哪些来源**有意义**。
 *
 * 判黑的唯一依据是"这张壁纸有多亮"，所以只有主进程**真的拿得到字节**的静帧图片算得出来
 * （见 main/theme-service.js#backgroundSource）：
 *   · `image` / `daily` —— 本地资产 / 每日一图，解码后量平均亮度（theme-luminance.js）；
 *   · `video` —— 画面在动，没有单一亮度可代表它（见 VIDEO_FG_HINT）；
 *   · `desktop` —— 目前没有取系统壁纸字节的通道，量不到亮度，摆开关等于给个假选项；
 *   · `none` / `color` / `css` —— 根本没有壁纸可量。
 */
export const AUTO_FG_BACKGROUND_KINDS = Object.freeze(['image', 'daily'])

/** @param {string} [kind] 背景来源 id（BACKGROUND_KINDS 的 value） */
export function supportsAutoFg(kind: string) {
  return AUTO_FG_BACKGROUND_KINDS.includes(kind)
}

/**
 * 编辑器「前景自动」总开关**此刻是否算开启** —— 判据是"三档里有没有 `auto`"。
 *
 * 为什么总开关不新增数据字段：`colors.*Fg = "auto"` 本来就是真源，开关只是它的一个
 * 视图（开 = 三个键一起写 `auto`，关 = 三个键写回此刻算出来的色）。于是导出的主题包、
 * 老数据、别人导入的包都不需要迁移。
 *
 * 判据用 `some` 而不是 `every`：手工改过包、或老版本只给了一档 `auto` 时，
 * 那一行会被锁死（取色器禁用），若开关显示"关"，用户就没有任何入口把它解锁 ——
 * 只要有一档在自动，开关就必须显示为开，点一下才能全部解锁。
 *
 * @param {{ colors?: Record<string, unknown> }} [theme]
 */
export function anyForegroundAuto(theme: { colors?: Record<string, unknown> }) {
  const colors = (theme && theme.colors) || {}
  return AUTO_FG_KEYS.some((key) => String(colors[key] == null ? '' : colors[key]).trim().toLowerCase() === AUTO_FG)
}

/**
 * 「自动前景」在**视频背景**下不可用的提示。
 *
 * 为什么必须明说：`colors.*Fg = "auto"` 靠"这张壁纸有多亮"**一个数**来判黑白，
 * 而动态画面根本没有单一亮度（首帧亮、中段可能全黑）。取首帧会给出错误的安全感 ——
 * 与其让作者以为"我已经开了自动，应该没问题"，不如直说"这里得手选"。
 * 见 docs-ng/主题系统设计.md §6.4.3。
 */
export const VIDEO_FG_HINT = '动态壁纸不参与「自动」前景判定（画面在动，没有单一亮度可代表它）——请手动指定前景色'

/** 背景铺法文案（id 来自真源）。 */
const BACKGROUND_POSITION_LABELS: Readonly<Record<string, string>> = {
  cover: '填满',
  contain: '完整显示',
  center: '居中',
  tile: '平铺',
  stretch: '拉伸'
}

export const BACKGROUND_POSITIONS = BACKGROUND_POSITION_IDS.map((value) => ({
  value,
  label: BACKGROUND_POSITION_LABELS[value] || value
}))

/** 背景作用范围文案（id 来自真源）。 */
const BACKGROUND_APPLY_TARGET_LABELS: Readonly<Record<string, string>> = {
  window: '浏览器窗口',
  newtab: '新标签页'
}

export const BACKGROUND_APPLY_TARGETS = BACKGROUND_APPLY_TARGET_IDS.map((value) => ({
  value,
  label: BACKGROUND_APPLY_TARGET_LABELS[value] || value
}))

export const BACKGROUND_SLIDERS = [
  { key: 'opacity', label: '图片不透明度', min: 0, max: 100, step: 1, unit: '%', scale: 100 },
  { key: 'blur', label: '背景模糊', hint: '只糊壁纸本身，0 = 保持原图清晰', min: 0, max: 60, step: 1, unit: 'px', scale: 1 },
  // 名字说清"遮罩的不透明度"——它与外观区的「工具栏透明度」是**两件事**
  // （一个管壁纸上的那层遮罩，一个管 chrome 的玻璃），含糊叫"透明度"时用户会调错。
  { key: 'overlay', label: '遮罩不透明度', hint: '只影响遮罩层', min: 0, max: 100, step: 1, unit: '%', scale: 100 }
]

/**
 * 「遮罩颜色」的取值口径 —— **直接转发共享层那一份**（`overlayColor → 默认白`）。
 *
 * 为什么必须转发而不是在这里再写一遍：编辑器**显示的值**必须与主进程**生效的值**
 * 逐字相同。分开写的后果已经出现过一次 —— 显示白、实际是深色，
 * 于是用户调「遮罩不透明度」看不到任何变化（"要么就是只能黑色遮罩"）。
 */
export { resolveVeilColor } from '../theme.js'

/**
 * 浏览器 UI（chrome）遮罩的两个生效值 —— 同样**直接转发共享层那一份**：
 *   · `resolveChromeOverlayColor(theme)` —— UI 遮罩色（未声明 → 主题底色）；
 *   · `resolveChromeOverlay(theme)`      —— UI 遮罩不透明度（未声明 → 老公式）。
 * 编辑器显示这两个值，主进程用这两个值算 CSS —— 同源，不存在"显示 ≠ 生效"。
 */
export {
  resolveChromeOverlay,
  resolveChromeOverlayColor,
  resolveChromeFg,
  resolvePanelFg,
  resolveWebSidebarFg,
  resolvePanelOverlay,
  // 「自动前景」：三档可取的哨兵值 + 键表（编辑器总开关一次写这三档）
  AUTO_FG,
  AUTO_FG_KEYS
} from '../theme.js'

/** 小时 → 展示用 `HH:00`（补零，避免 6:00 与 06:00 两处写法不一致）。 */
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

/**
 * 夜间窗口文案 —— **由真源常量派生**，不再手抄一遍时间。
 * `NIGHT_START_HOUR` / `NIGHT_END_HOUR` 改一处，这里与调度器一起跟着变。
 */
export const NIGHT_RANGE_TEXT = `${hourLabel(NIGHT_START_HOUR)} – ${hourLabel(NIGHT_END_HOUR)}`

/** 调度四档（id 来自真源 `shared-types#THEME_SCHEDULE_MODES`，这里只配文案）。 */
const SCHEDULE_MODE_TEXT: Readonly<Record<string, { label: string; hint: string }>> = {
  none: { label: '不自动切换', hint: '始终使用手动选择的主题。' },
  system: { label: '跟随系统', hint: '系统切到深色用下方「深色主题」，否则用「浅色主题」。' },
  night: {
    label: '白天 / 夜间',
    hint: `夜间窗口 ${NIGHT_RANGE_TEXT} 用「深色主题」，其余时间用「浅色主题」。`
  },
  manual: { label: '手动时段表', hint: '按下面的时段表逐条判定，命中即用那一条的主题。' }
}

export const SCHEDULE_MODES = THEME_SCHEDULE_MODES.map((value) => ({
  value,
  ...(SCHEDULE_MODE_TEXT[value] || { label: value, hint: '' })
}))

// ══════════════════════════════════════════════════════════════════════
// 小工具
// ══════════════════════════════════════════════════════════════════════

/**
 * 任意颜色 → `#rrggbb`（`<input type=color>` 只接受这个格式）。
 *
 * 主题里的颜色可能是 `rgba(…)`（作者给了半透明）—— 直接把它塞进 color input
 * 会被浏览器**清空成 #000000**，于是"打开编辑器一看，颜色白了"。
 * 所以这里做一次解析：解析不出就返回兜底，绝不吐空串给控件。
 */
export function toHexInput(color: unknown, fallback = '#000000'): string {
  const raw = String(color == null ? '' : color).trim()
  const hex = raw.replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return '#' + hex.toLowerCase()
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return '#' + hex.split('').map((c) => c + c).join('').toLowerCase()
  }
  const m = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (m) {
    const part = (n: unknown) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')
    return '#' + part(m[1]) + part(m[2]) + part(m[3])
  }
  return fallback
}

/** 0~1 的存储值 → 滑杆用的整数值（滑杆一律用整数，避免长小数在 UI 上抖）。 */
export function toSliderValue(value: unknown, scale: number, min: number, max: number): number {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : 0
  return Math.max(min, Math.min(max, Math.round(base * (scale || 1))))
}

/** 滑杆整数值 → 0~1 的存储值（scale=1 的滑杆原样返回）。 */
export function fromSliderValue(value: unknown, scale: number): number {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : 0
  return scale && scale !== 1 ? base / scale : base
}

/** 编辑器里要显示的主题名（草稿没有名字时给一个占位，不留空白输入框）。 */
export function draftName(draft: unknown): string {
  const record = draft && typeof draft === 'object' ? draft as Record<string, unknown> : {}
  const n = record.name ? String(record.name).trim() : ''
  return n || '自定义主题'
}

// ══════════════════════════════════════════════════════════════════════
// 渐变（背景 `kind: 'css'`）
// ══════════════════════════════════════════════════════════════════════
//
// 背景的"渐变"在模型里仍然只有一个字段 `background.css`（Vivaldi 兼容，不动 schema）。
// 但界面上**不逼用户写 CSS** —— 绝大多数用法就是"从 A 色到 B 色"，所以编辑器做一次
// 「解析 → 两个取色器 → 重新生成」的往返：方向等其余信息从原值里保留。
//
// 为什么解析只认「两个停靠点的线性渐变」：那正是两个取色器能表达的全部。
// 作者手写的多色 / 径向渐变解析不出来（返回 null），编辑器据此**不覆盖原值** ——
// 拆得面目全非比"改不了"更糟。

/** 新建渐变的起点（解析不出原值时用）。 */
export const DEFAULT_GRADIENT = Object.freeze({ direction: '135deg', from: '#0b0f14', to: '#123a5c' })

/** 顶层逗号切分 —— `rgba(0, 0, 0, .2)` 里的逗号不是分隔符。 */
function splitTopLevel(text: unknown): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of String(text)) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 取一个色标里的颜色部分（`#fff 40%` → `#fff`）；不是颜色返回空串。 */
function gradientColor(stop: unknown): string {
  const m = String(stop).match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/)
  return m ? m[1] : ''
}

/**
 * `linear-gradient(...)` → `{ direction, from, to }`；**解析不出返回 null**。
 *
 * 首段是颜色 = 原值省略了方向（CSS 语义是 `to bottom`），此时方向取 `180deg`。
 * @param {string} css
 * @returns {{ direction: string, from: string, to: string }|null}
 */
export function parseGradient(css: string) : { direction: string, from: string, to: string }|null {
  const raw = String(css || '').trim()
  const m = raw.match(/^linear-gradient\(([\s\S]*)\)$/i)
  if (!m) return null
  const parts = splitTopLevel(m[1])
  if (parts.length < 2) return null
  const hasDirection = !gradientColor(parts[0])
  const stops = (hasDirection ? parts.slice(1) : parts).map(gradientColor)
  if (stops.length !== 2 || !stops[0] || !stops[1]) return null
  return {
    direction: hasDirection ? parts[0] : '180deg',
    from: toHexInput(stops[0], DEFAULT_GRADIENT.from),
    to: toHexInput(stops[1], DEFAULT_GRADIENT.to)
  }
}

/** 两个色 + 方向 → `linear-gradient(...)`（与 `parseGradient` 互逆）。 */
export function buildGradient(spec: { direction?: unknown; from?: unknown; to?: unknown } | null | undefined): string {
  const s = spec || {}
  const dir = String(s.direction || '').trim() || DEFAULT_GRADIENT.direction
  const from = toHexInput(s.from, DEFAULT_GRADIENT.from)
  const to = toHexInput(s.to, DEFAULT_GRADIENT.to)
  return `linear-gradient(${dir}, ${from}, ${to})`
}

/**
 * 资产 key → 给用户看的文件名。
 *
 * key 的形状是 `<内容哈希8位>-<原文件名>.<扩展名>`（见 main/theme-assets.js）——
 * 哈希那一段对用户没有意义，这里只把它摘掉。
 */
export function assetDisplayName(key: unknown): string {
  const raw = String(key || '').trim()
  if (!raw) return ''
  return raw.replace(/^[0-9a-f]{8}-/i, '') || raw
}

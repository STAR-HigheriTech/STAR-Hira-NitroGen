/**
 * theme.mjs —— 主题的**唯一形状真源 + 令牌映射表**（跨进程纯函数）。
 *
 * 消费方：主进程（主题目录 / nativeTheme / 原生表面色）、渲染层（外壳写入根变量）、
 *         内部页（`hira://` 下 runtime.js 拉取令牌后写根变量）、新标签页（背景层）。
 *
 * ── 为什么必须有这一个文件 ────────────────────────────────────────────
 * 当前仓库里有**三套互不相干的令牌**：
 *   ① 外壳：`packages/shared-ui-tokens/*.css` 的 `--hira-*` + 一批旧变量（`--main-bg-color`…）
 *   ② 内部页：`apps/app-main/src/pages/_shared/base.css` 的 `--bg/--surface/--text/--accent…`
 *   ③ 新标签页：`pages/newtab/newtab.css` 的 `--ntp-*`
 * 三套靠「注释里写着同值」手工对齐。主题一旦要换配色，"同一个主题在三处颜色不一样"
 * 就是必然结果 —— 而那种 bug 既刺眼又说不清（改一个地方，另外两处不动）。
 * 所以：**颜色只有这一处产出**。本文件把一份主题解析成一张扁平变量表，
 * 三套令牌名只是**同一批值的三个别名**。
 *
 * ── 与 tokens-*.css 的关系 ────────────────────────────────────────────
 * 那些 CSS 文件里的 `:root` / `body.dark` 降级为**兜底默认值**：代码改到一半、
 * 或主题数据缺失时，界面仍然是可读的。改主题时由本文件产出的变量在更靠近根节点的
 * 内联层覆盖它们（内联 > 样式表，无需 `!important`）。
 *
 * ── 纯函数约束 ────────────────────────────────────────────────────────
 * 零依赖、零 IO、不 require electron。同 `layout.mjs` / `panel-entry.mjs`：
 * 主进程 `require()`、渲染层 `import` 的都是这一份（Electron 43 = Node 24，可直接加载 ESM）。
 */

// ══════════════════════════════════════════════════════════════════════
// 一、常量与枚举
// ══════════════════════════════════════════════════════════════════════

// 字体栈的**真源**在 `font-stack.mjs`（薄模块：页面侧 preload 要相对路径内联，
// 从 theme.mjs 取会把整张主题目录拖进每一页的 tab.js）。这里 re-export 保持旧引用可用。
import { UI_FONT_STACK, UI_MONO_STACK } from './font-stack.js'

export { UI_FONT_STACK, UI_MONO_STACK }

/**
 * 设置键名 —— 主进程 registry、applier、渲染层共用同一份。
 * 与 `layout.mjs#LAYOUT_SETTING_KEYS` 同样的理由：抄错一处就是一个静默失效的设置项。
 */
const THEME_SETTING_KEYS = Object.freeze({
  /**
   * 当前主题 **id**（不是 'light'/'dark'/'system'）。
   *
   * ⚠ 旧值是三态字符串，迁移由 `legacyActiveTheme()` 承担（见下）。
   * 之所以从"模式"改成"主题 id"：模式无法表达"两个暗色主题"，而 Vivaldi 的主题库里
   * 十有八九是同一个模式下的多个配色变体 —— 用户选的是**主题**，不是"亮/暗"。
   */
  active: 'app.theme',
  /** 调度：`{ mode, light, dark, entries }`（见 docs-ng/主题系统设计.md §7）。 */
  schedule: 'app.theme.schedule',
  /** 私密窗口专用主题 id（空串 = 与普通窗口相同）。 */
  privateTheme: 'app.theme.private_theme',
  /**
   * 用户主题目录（**数组**）—— 主题编辑器保存的成果。
   *
   * 为什么与插件主题分开放，而不是也做成一个插件目录：用户主题是**用户资产**，
   * 不该走"装/卸插件"那条链路（装一个插件只为了改三个颜色，而且还会出现在插件
   * 列表里、可能被卸载掉）。放在 settings 里同时也自动获得 profile 隔离与落盘。
   */
  userThemes: 'app.theme.user_themes'
})

/**
 * 主题来源 —— 决定「能不能编辑 / 能不能删」与在库里的分组。
 *   builtin 内置（`theme-builtins.js`）—— 永远存在，不可编辑，不可删
 *   user    主题编辑器建的（settings `app.theme.user_themes`）—— 可编辑、可删
 *   plugin  插件贡献的（manifest `contributes.themes` 或 `theme.source`）—— 归插件系统管
 */
const THEME_SOURCES = Object.freeze(['builtin', 'user', 'plugin'])

/**
 * 用户主题 id 前缀。
 *
 * 把"这条主题归谁"编码进 id 本身，于是**判据只有一处**（`isUserThemeId`）：
 * 编辑器拿到的主题能不能改、能不能删，不需要另外查一次目录来源表 ——
 * 那种"id 在这里、来源在那里"的对应关系迟早会不同步（比如插件被禁用后
 * 来源变了，而 id 没变）。
 */
const USER_THEME_ID_PREFIX = 'user.'

/** 主题模式：只有两种。**"跟随系统"不是主题，是调度的一种**（对齐 Vivaldi）。 */
const THEME_MODES = Object.freeze(['light', 'dark'])
export type ThemeMode = (typeof THEME_MODES)[number]

/** 主题模式的展示文案 —— 主题编辑器与引导页共用（两处各写一份必然漂移）。 */
const THEME_MODE_LABELS = Object.freeze({
  light: '浅色',
  dark: '深色'
})

/**
 * 主题模式归一化（**唯一判据**）：只有 light / dark 两种，其它值一律浅色。
 * 消费方：主题归一化、外壳 / 内部页写 `data-theme`、OOBE 与编辑器的模式文案。
 * @param {unknown} value
 * @returns {'light'|'dark'}
 */
function normalizeThemeMode(value: unknown) : 'light'|'dark' {
  return value === 'dark' ? 'dark' : 'light'
}

/** 主题模式 → 展示文案。 */
function themeModeLabel(mode: ThemeMode): string {
  return THEME_MODE_LABELS[normalizeThemeMode(mode)]
}

/** 背景来源种类。 */
const BACKGROUND_KINDS = Object.freeze([
  'none', // 不画背景（只有主题色）
  'color', // 纯色
  'css', // 任意 CSS background 值（渐变等）—— 内置主题用它，免去打包二进制
  'image', // 主题包内的图片
  /**
   * 主题包内的**视频**（动态壁纸）。
   *
   * 与 `image` 走**同一条链**（选文件 → 拷进资产库 → `path` 存 key → 协议给地址），
   * 差别只有两处：协议必须支持 `Range`（`<video>` 按段取流），以及"怎么画"——
   * 它不是 CSS 能表达的东西，渲染侧要有一个 `<video>` 元素（见
   * `shared-types/src/theme-background.mjs`，四个消费面共用那一份）。
   */
  'video',
  'daily', // 每日一图（联网拉取）
  'desktop' // 系统桌面壁纸
])

/**
 * 「指向一份**本地资产**」的背景种类（`background.path` 是资产库里的 key）。
 *
 * 为什么需要这个集合而不是各写各的数组字面量：它有三个消费方 ——
 * 派生用户主题时要不要降级成纯色、资产 URL 怎么拼、主题包导出/导入要不要带上这个文件。
 * 三处各写一遍 `=== 'image' || === 'video'`，加第三类资产时必漏一处。
 */
const BACKGROUND_ASSET_KINDS = Object.freeze(['image', 'video'])

/** 背景应用到哪几个面。 */
const BACKGROUND_APPLY_TARGETS = Object.freeze(['window', 'newtab'])

/** 背景位置口径（对齐 CSS background-size / Vivaldi 的 backgroundPosition）。 */
const BACKGROUND_POSITIONS = Object.freeze(['cover', 'contain', 'center', 'tile', 'stretch'])

/**
 * 着色模式。**只保留「统一着色」一档**。
 *
 * Vivaldi 原本分三档（标签栏 / 地址栏 / 统一），但本项目只有一套主题色：
 * 前两档从来没有消费者（`--hira-theme-colorize` 是无人读取的令牌），
 * 留在下拉里只会让人选到"怎么点都没反应"的档位 —— 假选项比没有选项更糟。
 *
 * 导入的 Vivaldi 主题若写着 `tabbar` / `addressbar`，由 `normalizeTheme`
 * 归一到 `unified`（不丢色、不报错）；导回 Vivaldi 时同样写 `unified`。
 */
const COLORIZE_MODES = Object.freeze(['unified'])

/**
 * 窗口材质（系统级模糊）。
 *
 * - `none`     —— 普通不透明窗口（默认）。
 * - `acrylic`  —— 亚克力：DWM 把窗口**背后的内容**实时模糊后画进窗口，最透。
 * - `mica`     —— Mica：DWM 取**桌面壁纸**做一次模糊（静态、更克制），Win11 22H2+。
 *
 * 它和 `background` **正交**：background 决定"窗口里画什么"，material 决定
 * "窗口本身是否透出系统模糊"。两者同时开启时，壁纸层叠在材质之上（壁纸仍可见）。
 *
 * 二者在原生层**都没有**染色 / 透明度参数 —— 观感差异只能靠 chrome 的染色
 * （`chromeOverlayColor` / `chromeOverlay` / `panelOverlay`）与模糊（`blur`）来调，
 * 编辑器的「材质与玻璃」分组就是这几根旋钮。
 */
const WINDOW_MATERIALS = Object.freeze(['none', 'acrylic', 'mica'])

/** 窗口材质 → 展示文案（UI 与日志共用，避免各处手写）。 */
const WINDOW_MATERIAL_LABELS = Object.freeze({
  none: '无（不透明）',
  acrylic: '亚克力（窗口后方实时模糊）',
  mica: 'Mica（Windows 11 桌面壁纸模糊）'
})

/**
 * 内置主题 id。**不随插件系统启停而消失** —— 插件体系整体不可用时
 * 界面仍需要一套可读的默认配色（`FALLBACK_PANELS` 的同一条理由）。
 */
const BUILTIN_THEME_IDS = Object.freeze(['hira-light', 'hira-dark'])

/**
 * 默认主题 id —— **"用户还没选"时的答案**：OOBE 首次启动、设置项缺失、
 * 当前主题被删除、引用的主题已不存在，全部回落到这里。
 *
 * 与 `BUILTIN_THEME_IDS` 的分工：那一组回答"插件全军覆没时哪些配色仍然在场"（保底可读），
 * 这一组回答"新装的第一眼给人看什么"（产品印象）—— 两件事别混成一个数组下标。
 *
 * 为什么默认不是朴素的「浅色」：系统级模糊窗口是本项目的招牌，首启就该看见；
 * 默认落在不透明的「浅色」，用户第一眼只会以为"毛玻璃根本没做"。
 * 不支持材质的机器（< Win11 22H2 / 非 Windows）上，原生层会把材质静默降级为不透明，
 * 观感等同「浅色」，不会出现"一片透不出来"的坏情况。
 *
 * 这里只写 id 字面量、不反向依赖 app 层：shared-types 是协议真源，
 * 内置目录在 `theme-builtins.js`（`hira-acrylic-*` 由 `materialVariant` 派生）。
 */
const DEFAULT_THEME_ID = 'hira-acrylic-light'

/** 调度里"没配过的"浅 / 深档默认值：与默认主题成对 —— 材质不能只在白天出现。 */
const DEFAULT_THEME_IDS = Object.freeze({ light: DEFAULT_THEME_ID, dark: 'hira-acrylic-dark' })

/** 旧三态值 → 新主题 id（一次性迁移用）。`system` 额外落成调度。 */
const LEGACY_THEME_ID_MAP: Readonly<Record<string, string>> = Object.freeze({
  light: BUILTIN_THEME_IDS[0],
  dark: BUILTIN_THEME_IDS[1],
  system: BUILTIN_THEME_IDS[0]
})

/** 调度模式：不切换 / 跟随系统 / 白天夜间 / 手动时段表。 */
const THEME_SCHEDULE_MODES = Object.freeze(['none', 'system', 'night', 'manual'])

/** 夜间窗口（旧 Hira `isNightTime`：21 点之后、6 点之前）。 */
const NIGHT_START_HOUR = 21
const NIGHT_END_HOUR = 6

/**
 * chrome 玻璃的**默认不透明度**（带壁纸时 chrome 自身底色的 alpha）。
 *
 * 为什么需要一个默认值而不是"theme 不说就完全不透明"：主题带了壁纸却不透出来，
 * 用户看到的仍是"主题换了、界面没变"——那正是这条特性存在的意义。
 * 0.55 是"壁纸明显可见、标签标题仍然读得清"的折中；作者可以用
 * `style.transparency` 在这个默认之上继续减（1 = 完全透出）。
 */
const CHROME_GLASS_ALPHA = 0.55

/**
 * 遮罩（veil）在**没有显式给颜色**时的默认色：**白色**。
 *
 * 为什么是白而不是"沿用背景色"：遮罩这层的作用是**提亮/压暗壁纸**，
 * 而它由两个正交字段控制 —— 颜色（`overlayColor`）与不透明度（`overlay`）。
 * 旧实现让颜色回落到"背景色"，于是深色主题下**实际生效的是近黑色**，
 * 而编辑器里显示的是白 —— **显示与生效不一致**，用户调「遮罩不透明度」时
 * 看到的是"没反应/永远是黑的"（这正是收到的那条反馈）。
 * 改成固定默认白之后：编辑器显示白 = 实际生效白，调不透明度立刻可见；
 * 想要压暗就把颜色改成黑（浅色文字在暗色壁纸上更清楚）。
 *
 * 它只在"作者没写 `overlayColor`"时生效；内置主题都显式给了色，不受影响。
 */
const DEFAULT_OVERLAY_COLOR = '#ffffff'

/**
 * 遮罩颜色（**唯一一处口径**）：显式色 → 默认白。
 *
 * 主进程算 CSS 用它，主题编辑器的「遮罩颜色」取色器也用它 ——
 * 两处各写一份判断必然漂移，而漂移的表现就是"看到的色和生效的色不一样"。
 */
function resolveVeilColor(backgroundRaw: unknown): string {
  const src = backgroundRaw && typeof backgroundRaw === 'object' ? backgroundRaw as Record<string, unknown> : {}
  return String(src.overlayColor || DEFAULT_OVERLAY_COLOR)
}

// ══════════════════════════════════════════════════════════════════════
// 二、颜色工具（纯函数）
//    只支持 hex 与 rgb()/rgba()：主题文件是用户可手改的 JSON，
//    放行 CSS 颜色名/命名空间会带来"看起来对、实际解析不出来"的静默失败。
// ══════════════════════════════════════════════════════════════════════

/**
 * 解析一个颜色为 `{ r, g, b, a }`；解析不了返回 null（由调用方回落）。
 * @param {unknown} input
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
interface ColorRgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(input: unknown): ColorRgba | null {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) return null

  const hex = raw.replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1
    }
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a
    }
  }

  const m = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (m) {
    const clamp255 = (n: unknown) => Math.max(0, Math.min(255, Math.round(Number(n))))
    const alpha = m[4] == null ? 1 : Math.max(0, Math.min(1, Number(m[4])))
    if (!Number.isFinite(alpha)) return null
    return { r: clamp255(m[1]), g: clamp255(m[2]), b: clamp255(m[3]), a: alpha }
  }
  return null
}

/** `{ r,g,b,a }` → CSS 字符串（a<1 时输出 rgba，否则输出 hex）。 */
function colorToCss(c: ColorRgba | null | undefined): string {
  if (!c) return ''
  const r = Math.round(c.r)
  const g = Math.round(c.g)
  const b = Math.round(c.b)
  const a = c.a == null ? 1 : c.a
  if (a >= 1) return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`
}

/** 改透明度；`color` 解析不了时返回空串。 */
function withAlpha(color: unknown, alpha: unknown): string {
  const c = parseColor(color)
  if (!c) return ''
  return colorToCss({ ...c, a: Math.max(0, Math.min(1, Number(alpha))) })
}

/**
 * 颜色混合：`t` 为**前者所占权重**（`mix(a, b, 0.1)` = 10% a + 90% b）。
 * 半透明参与混合时按"叠加"处理（先按 a 预乘再算），足够近似且不会越界。
 */
function mixColor(a: unknown, b: unknown, t: unknown): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca) return String(b == null ? '' : b)
  if (!cb) return String(a == null ? '' : a)
  const w = Math.max(0, Math.min(1, Number(t)))
  return colorToCss({
    r: ca.r * w + cb.r * (1 - w),
    g: ca.g * w + cb.g * (1 - w),
    b: ca.b * w + cb.b * (1 - w),
    a: ca.a * w + cb.a * (1 - w)
  })
}

/** 相对亮度（sRGB，WCAG 口径）—— 只用来决定"文字该用黑还是白"。 */
function relativeLuminance(color: unknown): number {
  const c = parseColor(color)
  if (!c) return 0
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/**
 * 在给定亮度（WCAG 相对亮度 0~1）上放文字该用深色还是浅色。
 *
 * 「自动前景」（见 `AUTO_FG`）与"品牌色上的白字判定"共用**同一条阈值** ——
 * 阈值只此一处，改这里两处一起改。
 */
function pickTextOnLuminance(luminance: unknown, darkText = '#1a1a1a', lightText = '#ffffff'): string {
  return Number(luminance) >= AUTO_FG_THRESHOLD ? darkText : lightText
}

/**
 * 在给定底色上放文字该用深色还是浅色。
 * 背景图带上亮度采样时，时钟文字也走这条判定（对齐旧 Hira `sampleImageLuminance`）。
 */
function readableTextOn(background: unknown, darkText = '#1a1a1a', lightText = '#ffffff'): string {
  return pickTextOnLuminance(relativeLuminance(background), darkText, lightText)
}

// ══════════════════════════════════════════════════════════════════════
// 「自动前景」：按背景明暗自动在**黑 / 白**之间选一档
// ══════════════════════════════════════════════════════════════════════

/**
 * 前景三档允许的**哨兵值**：`"chromeFg": "auto"`。它不是颜色，是"这一档交给公式算"。
 *
 * 为什么需要：壁纸是会变的（「每日一图」每天换一张图），而前景色是写死的 ——
 * 一张亮照片配白字 = 什么都看不见。自动档把"选黑还是白"交给下面那条公式。
 */
const AUTO_FG = 'auto'
/** 允许自动的三档（其余颜色键写 `auto` 会被当成非法值丢掉）。 */
const AUTO_FG_KEYS = Object.freeze(['chromeFg', 'panelFg', 'webSidebarFg'])
/** 自动档选出来的两个端点。深色用 #111 而不是纯黑 —— 压在玻璃面上纯黑过硬。 */
const AUTO_FG_DARK = '#111111'
const AUTO_FG_LIGHT = '#ffffff'
/** 判定阈值（WCAG 相对亮度）：≥ 它用深字，否则浅字。0.5 是标准中点。 */
const AUTO_FG_THRESHOLD = 0.5

/**
 * 某一档前景的**自动取值**：把它实际压着的那层算成"一个亮度"，再判黑/白。
 *
 * 有效亮度 = 遮罩色 ⊕ 壁纸亮度（按遮罩不透明度做合成）；
 *            面板**再叠一层**面板遮罩（面板比工具栏更实，见 resolvePanelOverlay）。
 * 壁纸**没铺在窗口面**时（`background.applyTo` 不含 window）chrome 仍是实底：
 * 那时直接按主题底色判，照片的明暗与它无关。
 * 于是"遮罩越白 → 越该用深字"是**算出来的**，不是猜的：
 * 白遮罩 0.55 压在暗照片（0.1）上 → 0.595 ⇒ 深字（正确：那一层已经偏亮了）。
 *
 * ⚠ 只拿得到"壁纸的**平均亮度**"（主进程按缩放后的位图算，见 theme-luminance.js），
 *   拿不到平均色 —— 所以这里的合成是在**亮度空间**做的（对白/黑这类中性遮罩是精确的，
 *   彩色遮罩会有一点色相偏差，可接受）。
 *   拿不到实测值时退回主题底色（= 编辑器里没换过图 / 图还没量完时的取值）。
 *
 * @param {any} themeRaw
 * @param {'chromeFg'|'panelFg'|'webSidebarFg'} key
 * @param {{ wallpaperLuminance?: number|null }} [opts] 壁纸实测平均亮度（0~1）
 */
function autoFgFor(
  themeRaw: unknown,
  key: 'chromeFg' | 'panelFg' | 'webSidebarFg',
  opts: { wallpaperLuminance?: number | null } = {}
): string {
  const t = normalizeTheme(themeRaw)
  const p = derivePalette(t)
  // 侧栏网页标题栏压在**实底**上（--hira-bg-surface = palette.bg，见 webSidebarHeader）
  // —— 与壁纸无关，所以它只按那个底色判，不受照片明暗影响。
  if (key === 'webSidebarFg') return readableTextOn(p.bg, AUTO_FG_DARK, AUTO_FG_LIGHT)
  /* 壁纸只有真的铺在**窗口**面时才会垫在前景底下（`glassSurface` 是唯一判据）。
     归一化保证「要新标签页 ⇒ 也铺窗口」（壁纸只有窗口那一份图层），
     所以"有壁纸但没铺窗口"这种状态已经不存在了；这里的分支保留给
     "只开窗口材质（无壁纸）→ 底是系统模糊后的桌面"那一档。 */
  const glass = glassSurface(t)
  const measured = opts && Number.isFinite(opts.wallpaperLuminance) ? Number(opts.wallpaperLuminance) : null
  let lum = glass && measured != null ? measured : relativeLuminance(p.bg)
  if (glass) {
    const veil = relativeLuminance(resolveChromeOverlayColor(t))
    const alpha = resolveChromeOverlay(t)
    lum = veil * alpha + lum * (1 - alpha)
    if (key === 'panelFg') {
      const pa = resolvePanelOverlay(t)
      lum = veil * pa + lum * (1 - pa)
    }
  }
  return pickTextOnLuminance(lum, AUTO_FG_DARK, AUTO_FG_LIGHT)
}

// ══════════════════════════════════════════════════════════════════════
// 三、主题归一化
// ══════════════════════════════════════════════════════════════════════

/**
 * UI 玻璃层的**最小模糊度**（px）—— 「UI 模糊」这根旋钮的下限，用户只能往上调。
 *
 * 为什么 UI 层必须有下限：chrome 的底色是半透明的，UI 背后必须有一层稳定的磨砂，
 * 否则壁纸细节会直接穿过工具栏与面板，文字对比度会随背景内容跳变。
 *
 * ⚠ 它**只约束 UI 层**，不参与 `background.blur`。壁纸自己可以完全不糊（0px），
 *   那是内容/背景的独立外观参数，与 UI 玻璃的可读性下限不是一件事。
 */
export const MIN_UI_BLUR = 10

const DEFAULT_STYLE = Object.freeze({
  /**
   * Vivaldi 的 `alpha`（工具栏透明层）。**只作为兼容回退**：
   * 主题没有显式给 `chromeOverlay` 时，用它算出"浏览器 UI 遮罩"的不透明度。
   *   · 无壁纸时它不起作用（chrome 恒为不透明，与改造前一致）；
   *   · 有壁纸时按 `CHROME_GLASS_ALPHA * (1 - transparency)` 得到默认透视。
   */
  transparency: 0,
  /** UI 玻璃层模糊（px）。Vivaldi「模糊」语义；下限见 MIN_UI_BLUR。 */
  blur: MIN_UI_BLUR,
  /** UI 元素对比度增强 0~1。Vivaldi「对比度」。 */
  contrast: 0,
  /** 圆角（px）—— **0 = 直角**（网页 / 面板 / chrome 全部一块直角），不存在"0 当未设置"的回落。 */
  cornerRadius: 6,
  /**
   * 视图边距（px）：网页 / 面板与 chrome 之间那一圈呼吸空（四边同值）。
   * `0` = 贴边 —— 没有那圈空隙，也就没有"边框"的观感。
   */
  contentInset: 4,
  /** 着色模式：只剩 `unified`（统一着色，主题色作用于整个界面）—— 见 `COLORIZE_MODES`。 */
  colorizeMode: 'unified',
  /**
   * **浏览器 UI（chrome）遮罩的不透明度** 0~1 —— 与「网页/新标签页背景的遮罩」
   * （`background.overlay`）**完全独立**的一根旋钮：一个管工具栏/侧栏压不住壁纸，
   * 一个管壁纸本身。
   *   · `1` = 完全挡住壁纸（chrome 不透明）；`0` = 完全透出。
   *   · `null` = **未声明** → 回退到 `transparency` 那条老公式（见上）。
   * 为什么用"不透明度"而不是"透明度"：正着说才不会让"滑杆拉满 = 更透"这种
   * 反直觉的事发生（用户反馈里"调不透明度没反应/只有黑的"就有这一半原因）。
   */
  chromeOverlay: null,
  /**
   * 浏览器 UI 遮罩的**颜色**（`''` = 用主题底色 —— 那是 Vivaldi 的口径：
   * 工具栏色就是 `colorBg`）。
   *
   * 为什么值得单开一个字段而不是永远用底色：底色是"网页/内容区的主背景"，
   * 而工具栏压在**壁纸**上 —— 想让它偏亮、偏冷、或干脆纯白，都得能单独调。
   * 默认沿用底色只是为了让"改造前的主题"观感一字不变。
   */
  chromeOverlayColor: '',
  /**
   * **面板**的遮罩不透明度 0~1（`null` = 跟随 `chromeOverlay`）。
   *
   * 为什么面板值得有自己的一根：面板是"压在壁纸上、要看里面内容"的地方，
   * 通常希望比工具栏**更实一点**（糊糊的壁纸上放列表不好读）；而工具栏可以更透
   * （它只是几颗图标 + 标签）。两者的最优值不在一个点上，所以分开。
   *   · 作用范围 = **面板视图**（下载 / 历史 / 书签…），不含 rail 与侧栏区
   *     —— 后两者是 chrome UI，走 `chromeOverlay`（见 §6.2 第 1 条）。
   *   · 没有配套的"面板毛玻璃"：面板是透明视图，背后透出的就是外壳 UI 玻璃层
   *     （`--hira-ui-blur`，即「UI 模糊」旋钮）已经处理好的结果。
   */
  panelOverlay: null,
  /**
   * 窗口材质：`none` | `acrylic` | `mica`（见 `WINDOW_MATERIALS`）。
   *
   * 它决定"窗口本身"是否透出系统模糊，与 `background`（窗口里画什么）正交。
   * 开启后 chrome 会走同一条玻璃判据（`glassSurface`），即使用户没选壁纸，
   * 也会得到半透明工具栏 + 透出桌面模糊的窗口 —— 这就是系统亚克力的观感。
   */
  material: 'none'
})

const DEFAULT_BACKGROUND = Object.freeze({
  kind: 'none',
  path: '',
  color: '',
  css: '',
  position: 'cover',
  opacity: 1,
  blur: 0,
  overlay: 0,
  overlayColor: '',
  applyTo: Object.freeze(['window', 'newtab'])
})

export interface ThemeBackground {
  kind: string
  path: string
  color: string
  css: string
  position: string
  opacity: number
  blur: number
  overlay: number
  overlayColor: string
  applyTo: string[]
  videoSrc?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
}

export interface ThemeStyle {
  transparency: number
  blur: number
  contrast: number
  cornerRadius: number
  contentInset: number
  colorizeMode: string
  chromeOverlay: number | null
  chromeOverlayColor: string
  panelOverlay: number | null
  material: string
}

export interface ThemeData {
  id: string
  name: string
  author: string
  version: string
  schemaVersion: number
  mode: ThemeMode
  colors: Record<string, string>
  style: ThemeStyle
  background: ThemeBackground
  icons: Record<string, string>
  preview: string | null
  source: string
  pluginId: string
}

export interface ThemeSchedule {
  mode: string
  light: string
  dark: string
  entries: Array<{ theme: string; from: number; to: number }>
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function pickText(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    // 名称支持 `{ 'zh-CN': …, 'en-US': … }`（与插件 manifest 的 name/description 同构）
    const record = value as Record<string, unknown>
    const zh = record['zh-CN'] || record.zh || record['en-US'] || record.en
    return String(zh == null ? fallback : zh)
  }
  return value == null || value === '' ? fallback : String(value)
}

/**
 * 归一化一份主题定义。缺省与非法值**全部回落**，消费方不必再判 `undefined`。
 *
 * ⚠ 刻意不在 `colors` 上做"派生值也写进 colors"：派生在 `themeToTokens()` 里做，
 *   于是"作者只给了 3 个颜色"和"作者给了全部 20 个"走的是同一条出口。
 *
 * @param {any} raw
 * @returns {{
 *   id: string, name: string, author: string, version: string, schemaVersion: number,
 *   mode: 'light'|'dark',
 *   colors: Record<string, string>,
 *   style: { transparency: number, blur: number, contrast: number, cornerRadius: number,
 *            contentInset: number,
 *            colorizeMode: string, chromeOverlay: number|null, chromeOverlayColor: string,
 *            panelOverlay: number|null, material: string },
 *   background: { kind: string, path: string, color: string, css: string, position: string,
 *                 opacity: number, blur: number, overlay: number, overlayColor: string, applyTo: string[] },
 *   icons: Record<string, string>, preview: string|null, source: string
 * }}
 */
function normalizeTheme(raw: unknown): ThemeData {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const colors = src.colors && typeof src.colors === 'object' ? src.colors as Record<string, unknown> : {}
  const outColors: Record<string, string> = {}
  for (const [key, value] of Object.entries(colors)) {
    /* 前景三档允许哨兵值 `auto`（= 按背景明暗自动黑/白，见 autoFgFor）：
       它不是颜色，不能走 parseColor —— 但要**原样留下**，否则"自动"这个选择
       一存盘就被丢掉（表现就是"选了自动、回来又变回手填的色"）。
       其余颜色键写 auto 仍然按非法值丢弃（例如 bg 写 auto 会让派生色全乱）。 */
    if (AUTO_FG_KEYS.includes(key) && typeof value === 'string' && value.trim().toLowerCase() === AUTO_FG) {
      outColors[key] = AUTO_FG
      continue
    }
    const c = parseColor(value)
    if (c) outColors[key] = colorToCss(c)
  }

  const style = src.style && typeof src.style === 'object' ? src.style as Record<string, unknown> : {}
  const bg = normalizeThemeBackground(src.background)
  const icons = src.icons && typeof src.icons === 'object' ? { ...src.icons as Record<string, string> } : {}

  return {
    id: String(src.id == null ? '' : src.id),
    name: pickText(src.name, String(src.id == null ? '' : src.id)),
    author: String(src.author == null ? '' : src.author),
    version: String(src.version == null ? '0.0.0' : src.version),
    schemaVersion: Number.isFinite(Number(src.schemaVersion)) ? Number(src.schemaVersion) : 1,
    mode: normalizeThemeMode(src.mode),
    colors: outColors,
    style: {
      transparency: num(style.transparency, DEFAULT_STYLE.transparency, 0, 1),
      // 下限 MIN_UI_BLUR 只约束 UI 玻璃层；背景壁纸走独立的 background.blur。
      blur: num(style.blur, MIN_UI_BLUR, MIN_UI_BLUR, 60),
      contrast: num(style.contrast, DEFAULT_STYLE.contrast, 0, 1),
      cornerRadius: num(style.cornerRadius, DEFAULT_STYLE.cornerRadius, 0, 24),
      contentInset: num(style.contentInset, DEFAULT_STYLE.contentInset, 0, 16),
      colorizeMode: typeof style.colorizeMode === 'string' && (COLORIZE_MODES as readonly string[]).includes(style.colorizeMode)
        ? style.colorizeMode
        : DEFAULT_STYLE.colorizeMode,
      /**
       * `null` 与 `0` 必须分得开：`null` = 作者没说过（走 transparency 老公式），
       * `0` = 作者明确要求"完全透出壁纸"。写成 `num(...)` 兜底 0 就把这两件事混了。
       */
      chromeOverlay: style.chromeOverlay == null || style.chromeOverlay === ''
        ? null
        : num(style.chromeOverlay, CHROME_GLASS_ALPHA, 0, 1),
      chromeOverlayColor: (() => {
        const c = parseColor(style.chromeOverlayColor)
        return c ? colorToCss(c) : ''
      })(),
      /** 同上：`null`（跟随 chromeOverlay）与 `0`（明确要全透）必须分得开。 */
      panelOverlay: style.panelOverlay == null || style.panelOverlay === ''
        ? null
        : num(style.panelOverlay, CHROME_GLASS_ALPHA, 0, 1),
      /** 窗口材质只接受白名单值；未知名一律回落 `none`，避免把任意字符串传给原生层。 */
      material: typeof style.material === 'string' && (WINDOW_MATERIALS as readonly string[]).includes(style.material)
        ? style.material
        : DEFAULT_STYLE.material
    },
    background: bg,
    icons,
    preview: src.preview ? String(src.preview) : null,
    /** 'builtin' | 'plugin' | 'user' | 'custom' —— 只用于 UI 分组与"能不能删"。 */
    source: String(src.source == null ? 'plugin' : src.source),
    /**
     * 贡献这条主题的插件 id（内置与用户主题为空串）。
     *
     * 为什么必须随主题一起带着走：主题包里的**背景图**住在插件目录里，取用要拼
     * `hira-plugin://<pluginId>/background.jpg`（见 theme-service#backgroundFor）。
     * 少了这个字段，"图片主题"就只能一直显示兜底色 —— 而那正是"我装了主题却没反应"
     * 这类最难查的问题。它由贡献注册表在 `contributes.themes` 上打标（见
     * infra-plugin#contributions 的 list()）。
     */
    pluginId: String(src.pluginId == null ? '' : src.pluginId)
  }
}

/**
 * 归一化背景段。
 * @param {any} raw
 */
function normalizeThemeBackground(raw: unknown): ThemeBackground {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const applyTo = Array.isArray(src.applyTo)
    ? src.applyTo.filter((t) => BACKGROUND_APPLY_TARGETS.includes(t))
    : [...DEFAULT_BACKGROUND.applyTo]
  /**
   * 「要铺在新标签页」必然也「铺在窗口」。
   *
   * 壁纸现在**只有一份**，画在窗口外壳那一层（`#chrome-theme-background`，所有视图之下）；
   * 新标签页是透明画布，只是把那层透出来 —— 它自己不再画第二份。
   * 于是「只勾新标签页、不勾窗口」在这套结构里无法表达：窗口面不画，新标签页就看不到。
   * 与其让用户勾了一个不生效的选项（旧数据里就有这种，例如内置「樱花浅」），
   * 不如在归一化这一步把 `newtab ⇒ window` 补上，让数据本身就自洽。
   */
  if (applyTo.includes('newtab') && !applyTo.includes('window')) applyTo.push('window')
  const color = parseColor(src.color)
  const overlayColor = parseColor(src.overlayColor)
  return {
    kind: typeof src.kind === 'string' && (BACKGROUND_KINDS as readonly string[]).includes(src.kind) ? src.kind : DEFAULT_BACKGROUND.kind,
    path: src.path ? String(src.path) : '',
    color: colorToCss(color),
    css: src.css ? String(src.css) : '',
    position: typeof src.position === 'string' && (BACKGROUND_POSITIONS as readonly string[]).includes(src.position) ? src.position : DEFAULT_BACKGROUND.position,
    opacity: num(src.opacity, DEFAULT_BACKGROUND.opacity, 0, 1),
    blur: num(src.blur, DEFAULT_BACKGROUND.blur, 0, 60),
    overlay: num(src.overlay, DEFAULT_BACKGROUND.overlay, 0, 1),
    overlayColor: colorToCss(overlayColor),
    /** 去重并保序：重复项会让"应用到窗口/新标签页"两个勾选框表现不一致。 */
    applyTo: applyTo.length ? [...new Set(applyTo)] : [...DEFAULT_BACKGROUND.applyTo]
  }
}

/** 是不是暗色主题。 */
function isDarkTheme(theme: ThemeData | null | undefined): boolean {
  return !!(theme && normalizeThemeMode(theme.mode) === 'dark')
}

/** 这条主题 id 是不是"用户主题"（编辑器建的、可改可删）。 */
function isUserThemeId(id: unknown): boolean {
  return String(id == null ? '' : id).startsWith(USER_THEME_ID_PREFIX)
}

/**
 * 从一个基础主题派生出**新的用户主题**（编辑器「新建主题 / 另存为副本」的起点）。
 *
 * 为什么这条规则放在共享层而不是编辑器里：编辑窗口（渲染层）需要立刻画出一份可编辑的
 * 草稿，而主进程保存时要按同一条规则归一化 —— 起点不一致就会出现"编辑器里看到的是 A、
 * 存下去变成 B"。所以"新主题长什么样"只能有一处实现。
 *
 * 背景的**来源型**种类（图片 / 视频 / 每日图 / 桌面壁纸）在派生时降级为纯色：
 * 那些种类指向一份外部资产（主题包内的文件 / 网络 / 系统），复制到新主题里只会得到
 * 一个"引用不存在的文件"的主题。作者随后在编辑器里重新选。
 *
 * @param {any} base 作为起点的主题（通常是当前主题）
 * @param {{ id?: string, name?: string }} [opts] `id` 留空 = 尚未保存的新主题
 */
function createUserTheme(base: unknown, opts: { id?: string; name?: string } = {}): ThemeData {
  const src = normalizeTheme(base || {})
  const bg = src.background
  const sourceKinds = [...BACKGROUND_ASSET_KINDS, 'daily', 'desktop']
  return normalizeTheme({
    ...src,
    id: String((opts && opts.id) || ''),
    name: String((opts && opts.name) || '自定义主题'),
    author: '',
    source: 'user',
    icons: {},
    preview: null,
    background: sourceKinds.includes(bg.kind)
      ? { ...bg, kind: 'color', path: '', color: bg.color || src.colors.bg || '' }
      : bg
  })
}

/**
 * 把设置里的原始值解析成**主题 id**（兼容旧三态）。
 *
 * 迁移策略（对齐 docs-ng/主题系统设计.md §11）：
 *   · `light` / `dark` → 对应内置主题；
 *   · `system`         → 内置浅色 + 调用方另行写入 `schedule.mode='system'`；
 *   · 空值（从没设置过） → **默认主题**（`DEFAULT_THEME_ID`，亚克力浅）；
 *   · 其它未识别值      → 默认主题（**绝不因为一个坏值让界面白屏**）。
 *
 * @param {unknown} value
 * @returns {{ id: string, wasLegacy: boolean, wantsSystemSchedule: boolean }}
 */
function legacyActiveTheme(value: unknown) : { id: string, wasLegacy: boolean, wantsSystemSchedule: boolean } {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return { id: DEFAULT_THEME_ID, wasLegacy: false, wantsSystemSchedule: false }
  const mapped = LEGACY_THEME_ID_MAP[raw]
  if (mapped) {
    return { id: mapped, wasLegacy: true, wantsSystemSchedule: raw === 'system' }
  }
  return { id: raw, wasLegacy: false, wantsSystemSchedule: false }
}

/** 调度配置归一化（主进程 theme-schedule.js 消费）。 */
function normalizeThemeSchedule(raw: unknown): ThemeSchedule {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const mode = typeof src.mode === 'string' && (THEME_SCHEDULE_MODES as readonly string[]).includes(src.mode) ? src.mode : 'none'
  const entries = Array.isArray(src.entries)
    ? src.entries
        .map((e: unknown) => {
          const s = e && typeof e === 'object' ? e as Record<string, unknown> : {}
          return { theme: s.theme ? String(s.theme) : '', from: normalizeHour(s.from), to: normalizeHour(s.to) }
        })
        .filter((e) => e.theme)
    : []
  return {
    mode,
    light: src.light ? String(src.light) : DEFAULT_THEME_IDS.light,
    dark: src.dark ? String(src.dark) : DEFAULT_THEME_IDS.dark,
    entries
  }
}

/** 小时归一化到 0~23 的整数。 */
function normalizeHour(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(23, Math.max(0, Math.floor(n)))
}

/**
 * 当前时刻是否落在"白天"（**调度判定唯一入口**）。
 *
 * 为什么放在共享层：主进程调度器要用它，而说明文案（"21:00–06:00 为夜间"）
 * 在设置页也要显示同一个区间 —— 两处各写一份必然漂移。
 *
 * `entries` 手动时段表按顺序命中即返回；都不命中时回落 `night` 判定。
 */
function isNightNow(schedule: ThemeSchedule, date = new Date()): boolean {
  const s = normalizeThemeSchedule(schedule)
  const hour = date.getHours()
  if (s.mode === 'manual' && s.entries.length) {
    for (const e of s.entries) {
      const inside = e.from <= e.to ? hour >= e.from && hour < e.to : hour >= e.from || hour < e.to
      if (inside) return e.theme === s.dark
    }
    return false
  }
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
}

// ══════════════════════════════════════════════════════════════════════
// 四、★ 令牌映射表：一份主题 → 三套令牌名
// ══════════════════════════════════════════════════════════════════════

/**
 * 由主题的少量基础色**派生**出全部中间色。
 *
 * 作者最少只写 `bg / fg / accent` 三个；其余按模式（亮/暗）向右取反方向推导。
 * **内置主题会显式给出全部色值**（`colors` 里有没有这个键就走哪条路），
 * 于是"默认主题的像素与改造前完全一致"与"第三方主题只写三个色也好看"两件事同时成立。
 *
 * 派生规则：`mix(fg, bg, t)` = t 份前景色叠在底色上 ——
 *   亮色下得到"更黑一点的灰"（正是 hover/边框该有的样子）；
 *   暗色下得到"更亮一点的灰"。一条公式同时覆盖两种模式。
 */
function derivePalette(theme: ThemeData): Record<string, string> {
  const dark = isDarkTheme(theme)
  const c = theme.colors || {}
  const bg = c.bg || (dark ? '#1e1e1e' : '#f9fafb')
  const fg = c.fg || (dark ? '#e8e8e8' : '#1a1a1a')
  const accent = c.accent || (dark ? '#5b9bff' : '#3b82f6')
  /** 抬升面始终朝白走：亮色下更白，暗色下也只是"浅一点的暗"。 */
  const elevate = (t: number) => mixColor('#ffffff', bg, dark ? t * 0.18 : t)

  return {
    bg,
    fg,
    accent,
    surface: c.surface || elevate(0.72),
    solid: c.solid || elevate(0.95),
    bgSubtle: c.bgSubtle || mixColor(fg, bg, 0.06),
    surfaceSoft: c.surfaceSoft || mixColor(fg, bg, 0.04),
    hover: c.hover || mixColor(fg, bg, dark ? 0.06 : 0.05),
    field: c.field || mixColor(fg, bg, 0.04),
    fieldFocus: c.fieldFocus || mixColor(fg, bg, 0.05),
    track: c.track || mixColor(fg, bg, 0.1),
    /** 开关关闭态轨道：比 track 略强一档，由前景色带透明度得到（跟随主题明暗）。 */
    switchOff: c.switchOff || withAlpha(fg, dark ? 0.22 : 0.16),
    border: c.border || mixColor(fg, bg, 0.1),
    borderStrong: c.borderStrong || mixColor(fg, bg, 0.24),
    textSoft: c.textSoft || mixColor(fg, bg, 0.6),
    textMuted: c.textMuted || mixColor(fg, bg, 0.45),
    accentHover: c.accentHover || mixColor('#000000', accent, dark ? 0.12 : 0.18),
    accentSoft: c.accentSoft || withAlpha(accent, dark ? 0.18 : 0.12),
    /** 选中/高亮底（Vivaldi `colorHighlightBg`）—— 作者给了就用它，否则由强调色派生。 */
    highlight: c.highlight || withAlpha(accent, dark ? 0.28 : 0.16),
    danger: c.danger || (dark ? '#ff7b72' : '#dc2626'),
    dangerBg: c.dangerBg || withAlpha(dark ? '#ff7b72' : '#dc2626', dark ? 0.16 : 0.08),
    warn: c.warn || (dark ? '#fbbf24' : '#d97706'),
    warnBg: c.warnBg || withAlpha(dark ? '#fbbf24' : '#d97706', 0.14),
    /** 成功/安全态（扩展已启用、权限已允许、下载完成）。与 danger / warn 同级。 */
    success: c.success || (dark ? '#4ade80' : '#16a34a'),
    successBg: c.successBg || withAlpha(dark ? '#4ade80' : '#16a34a', dark ? 0.16 : 0.1),
    /** 锚定在"不透明的实底"上算，避免半透明底导致黑白判定翻转。 */
    onAccent: c.onAccent || readableTextOn(accent)
  }
}

/**
 * 该主题的壁纸是否正铺在**窗口**面（= chrome 该不该变玻璃）。
 * 判据只有这一处：chrome 玻璃、原生表面色（theme-runtime）都问它。
 */
function glassesWindow(themeRaw: ThemeData): boolean {
  const t = normalizeTheme(themeRaw)
  const bg = t.background
  return bg.kind !== 'none' && bg.applyTo.indexOf('window') >= 0
}

/**
 * 主题是否选了窗口材质（亚克力等系统模糊）。
 * @param {any} themeRaw
 */
function hasWindowMaterial(themeRaw: unknown) {
  const t = normalizeTheme(themeRaw)
  return t.style.material !== 'none'
}

/**
 * **玻璃面判据（唯一一处）**：窗口要不要"透"。
 *
 * 两个来源等价：
 *   · 有壁纸铺在窗口面（`glassesWindow`）—— 壁纸需要透出来；
 *   · 选了窗口材质（`hasWindowMaterial`）—— 系统模糊需要透出来。
 *
 * 它替代了原先散落在 chrome 遮罩 / 面板遮罩 / 自动前景里的 `glassesWindow` 判断：
 * 否则"只开亚克力、没选壁纸"时 chrome 仍是不透明实底，把系统模糊整个挡住 ——
 * 那正是"有垃圾的不透明图层阻碍"的表现。
 */
function glassSurface(themeRaw: ThemeData): boolean {
  const t = normalizeTheme(themeRaw)
  return t.style.material !== 'none' || glassesWindow(t)
}

/**
 * 窗口材质的规格（给主进程/UI 的稳定结构，避免各自读 `style.material`）。
 * @param {any} themeRaw
 * @returns {{ material: string, active: boolean }}
 */
function windowMaterialSpec(themeRaw: unknown) : { material: string, active: boolean } {
  const t = normalizeTheme(themeRaw)
  return Object.freeze({
    material: t.style.material,
    active: t.style.material !== 'none'
  })
}

/**
 * 浏览器 UI（chrome）遮罩的**颜色生效值**：显式色 → 主题底色。
 *
 * 与 `resolveVeilColor` 同一条纪律：**主进程算 CSS 与编辑器的取色器共用它**，
 * 否则又会出现"显示一个色、生效另一个色"（那条反馈已经吃过一次）。
 */
function resolveChromeOverlayColor(themeRaw: ThemeData): string {
  const t = normalizeTheme(themeRaw)
  return t.style.chromeOverlayColor || derivePalette(t).bg
}

/**
 * 浏览器 UI（chrome）遮罩的**不透明度生效值**（1 = 完全挡住壁纸）。
 *
 * 取值链（唯一一处）：
 *   · **不是玻璃面**（既无窗口壁纸、也没开窗口材质）→ 恒为 1（chrome 不透明，与改造前逐字一致）；
 *   · 作者显式给了 `chromeOverlay` → 用它（0 也是有效值：完全透出）；
 *   · 否则 → `CHROME_GLASS_ALPHA * (1 - style.transparency)`：
 *     玻璃面默认就有 45% 的透视（`transparency` 是 Vivaldi 的 alpha 字段，
 *     作为兼容回退保留）。
 */
function resolveChromeOverlay(themeRaw: ThemeData): number {
  const t = normalizeTheme(themeRaw)
  if (!glassSurface(t)) return 1
  if (t.style.chromeOverlay != null) return clamp01(t.style.chromeOverlay)
  return Math.max(0, CHROME_GLASS_ALPHA - t.style.transparency * CHROME_GLASS_ALPHA)
}

/** 夹到 0~1（颜色/不透明度都走它，避免两处各写一遍 clamp）。 */
function clamp01(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 浏览器 UI 的**前景色生效值**：`colors.chromeFg` → 主题前景色；
 * 写 `auto` 时按背景明暗自动黑/白（见 autoFgFor）。
 *
 * 为什么要单开这一个槽位：`colors.fg` 是"**内容**的前景"（网页文案、内部页正文），
 * 而工具栏 / 标签栏 / rail 的图标与文字是**另一件事** —— 深色壁纸配深色工具栏时，
 * 用户常想把 chrome 的前景调亮，却不希望内部页跟着一起变。默认沿用 `fg`，
 * 于是改造前的主题一字不变。
 *
 * 落点：`--hira-text-primary` / `--text-color` / `--hira-chrome-fg`（工具栏 / 标签栏 /
 * rail 及其组件）。**面板与侧栏网页标题栏各有一档**，未设时跟随它。
 *
 * @param {any} themeRaw
 * @param {{ wallpaperLuminance?: number|null }} [opts]
 */
function resolveChromeFg(themeRaw: unknown, opts: { wallpaperLuminance?: number | null } = {}): string {
  const t = normalizeTheme(themeRaw)
  if (t.colors.chromeFg === AUTO_FG) return autoFgFor(t, 'chromeFg', opts)
  return t.colors.chromeFg || derivePalette(t).fg
}

/**
 * **面板**（下载 / 历史 / 书签…那几条侧栏面板）里文字与图标的**前景生效值**：
 * `colors.panelFg` → UI 前景。
 *
 * 为什么值得单开一档：面板的底是"在 UI 遮罩之上**再叠**一层"（比工具栏更实，见
 * resolvePanelOverlay），同一档前景压在这两种厚薄上的可读性并不一样 ——
 * 深色玻璃面板上常常要更亮的前景，而工具栏又不想跟着一起变亮。
 * 默认沿用 UI 前景，于是改造前的主题一字不变。
 * 落点在**面板自己的视图**里：子树根上把三档文字色按它重算
 * （见 ui-common#injectPanelStyles）—— 一处声明、整棵面板子树（含共享组件）跟着走。
 */
function resolvePanelFg(themeRaw: unknown, opts: { wallpaperLuminance?: number | null } = {}): string {
  const t = normalizeTheme(themeRaw)
  if (t.colors.panelFg === AUTO_FG) return autoFgFor(t, 'panelFg', opts)
  return t.colors.panelFg || resolveChromeFg(t, opts)
}

/**
 * **独立侧栏（网页浏览）顶部标题栏**的前景生效值：`colors.webSidebarFg` → UI 前景。
 *
 * 那条栏很窄、字很小，还常压在域名与图标上 —— 它需要的对比度与工具栏并不相同，
 * 所以同样单开一档。默认沿用 UI 前景。
 * 落点在 ui-common#webSidebarHeader 的 `.hira-ws-header`（同样是子树级重算三档）。
 */
function resolveWebSidebarFg(themeRaw: unknown, opts: { wallpaperLuminance?: number | null } = {}): string {
  const t = normalizeTheme(themeRaw)
  if (t.colors.webSidebarFg === AUTO_FG) return autoFgFor(t, 'webSidebarFg', opts)
  return t.colors.webSidebarFg || resolveChromeFg(t, opts)
}

/**
 * **面板**（下载 / 历史 / 书签…那几条侧栏面板）那一层遮罩的不透明度生效值。
 *
 * 它与「UI 遮罩」是**两根独立的旋钮**，但落点不同：
 *   · UI 遮罩（chromeOverlay）铺在**外壳**上（工具栏 / 内容洞 / 侧栏区，见 app-shell）；
 *   · 面板遮罩（本函数）由**面板自己的视图**铺（ui-common#injectPanelStyles）——
 *     面板是独立 WebContentsView，盖在外壳内容洞之上，所以它是"在 UI 遮罩之上**再叠**一层"。
 * 取值链：无壁纸 → 1；作者给了 `panelOverlay` → 用它；否则**跟随 UI 遮罩** —— 默认什么都不改。
 *
 * ⚠ 它**不**作用于 rail，也**不**作用于侧栏区（垂直标签栏）：那两个是 chrome UI，
 * 跟随 chromeOverlay / chromeBlur。曾经把它铺在 `#chrome-side` 上，于是"调面板
 * 把垂直标签栏也改了"（用户明确指正过）。
 */
function resolvePanelOverlay(themeRaw: ThemeData): number {
  const t = normalizeTheme(themeRaw)
  if (!glassSurface(t)) return 1
  if (t.style.panelOverlay != null) return clamp01(t.style.panelOverlay)
  return resolveChromeOverlay(t)
}

/**
 * 主题 → **一张扁平变量表**（唯一产出点）。
 *
 * 返回的表里同时含三套令牌名，它们指回同一批值：
 *   · 外壳 `--hira-*` + 旧变量（`--main-bg-color` / `--bg-color` …）
 *   · 内部页 `--bg / --surface / --text / --accent …`
 *   · 新标签页 `--ntp-*`
 *
 * 消费方只需 `for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v)`。
 *
 * @param {any} themeRaw
 * @param {{ wallpaperLuminance?: number|null }} [opts]
 *   壁纸实测平均亮度（0~1）—— 只被「自动前景」那一档用到（`colors.*Fg === 'auto'`）。
 *   主进程从主题资产 / 每日一图量出来（见 apps/main/theme-luminance.js）；拿不到时
 *   自动档退回主题底色，仍然是个确定的值（不会出现空令牌）。
 * @returns {Record<string, string>}
 */
function themeToTokens(themeRaw: unknown, opts: { wallpaperLuminance?: number | null } = {}): Record<string, string> {
  const theme = normalizeTheme(themeRaw)
  const p = derivePalette(theme)
  const style = theme.style
  const bg = theme.background

  /**
   * ── chrome 玻璃（Vivaldi 的"工具栏透出壁纸"）─────────────────────────
   *
   * 两个**互相独立**的旋钮（都只在"有窗口壁纸"时起作用）：
   *   · `style.chromeOverlayColor` —— UI 遮罩什么色（默认主题底色）；
   *   · `style.chromeOverlay`      —— UI 遮罩多不透（默认见 resolveChromeOverlay）。
   * 判据与取值链全在 `resolveChromeOverlay*` 里（**编辑器显示的就是它们**，
   * 显示与生效必须同源 —— 这条已经吃过一次亏）。
   *
   * 无壁纸时 chromeAlpha 恒为 1 = 与改造前**逐字一致**，零回归
   * （有壁纸就必然铺在窗口面 —— 归一化保证 newtab ⇒ window，见 normalizeThemeBackground）。
   */
  const chromeAlpha = resolveChromeOverlay(theme)
  /**
   * chrome 的玻璃色（**每处只该铺一层**）。
   *
   * 带壁纸时它就是"UI 遮罩色 + 不透明度"，由外壳**按区域各铺一片**
   * （工具栏 / 内容洞 / 侧栏区，见 app-shell 的那段规则）；
   * 无壁纸时是主题底色本身（与改造前逐字相同）。
   */
  const chromeBg = chromeAlpha >= 1 ? p.bg : withAlpha(resolveChromeOverlayColor(theme), chromeAlpha) || p.bg
  /**
   * **面板**自己那一层（下载 / 历史 / 书签…）—— 与工具栏那一层各一条。
   * 颜色沿用 UI 遮罩色（用户要的是"面板的强度可以单独调"），只独立不透明度。
   * 落点在**面板的视图**里（跨视图拿不到外壳那层，见 ui-common#injectPanelStyles），
   * 因此语义是"叠在 UI 遮罩之上的一层"，不是"替换那一层"。
   */
  const panelAlpha = resolvePanelOverlay(theme)
  const panelBg = panelAlpha >= 1 ? p.bg : withAlpha(resolveChromeOverlayColor(theme), panelAlpha) || p.bg
  /** 浏览器 UI 的前景色（工具栏/标签栏/rail/面板的图标与文字），与内容前景分家。 */
  const chromeFg = resolveChromeFg(theme, opts)
  /**
   * **面板** / **侧栏网页标题栏** 各自的独立前景（未设时 = UI 前景 ⇒ 逐字不变）。
   *
   * `*Set` 是"作者**显式**设过"的事实：只有显式设过时才重算那两档的次要/辅助色
   * （本色降透明度），否则沿用主题原本的 textSoft / textMuted —— 这样"默认逐字不变"
   * 与"设了之后三档一起跟着走（不会半截留在旧色上）"两件事同时成立。
   * 派生串交给 CSS 的 color-mix 在**用的时候**算，JS 不做颜色运算。
   */
  const panelFg = resolvePanelFg(theme, opts)
  const wsHeaderFg = resolveWebSidebarFg(theme, opts)
  const panelFgSet = !!theme.colors.panelFg
  const wsHeaderFgSet = !!theme.colors.webSidebarFg

  /** @type {Record<string, string>} */
  const tokens: Record<string, string> = {
    /**
     * UI 字体栈 —— 与配色无关的**静态令牌**，但必须随主题一起下发：
     * 面板 / 浮层 / 内部页 / 子窗口各自是独立 WebContentsView，只有这条通道能让
     * 它们拿到**同一份**字体栈（否则各文件各写一套，必然漂移成"有的宋体、有的雅黑"）。
     */
    '--hira-font-ui': UI_FONT_STACK,
    /**
     * 等宽栈 —— 同样随主题下发。只写 `monospace` 时中文会回退到 NSimSun（点阵宋），
     * 所以它和 UI 栈一样必须显式带中文 UI 字体；统一成一个令牌，代码块/十六进制输入
     * 才不会各写一套。
     */
    '--hira-font-mono': UI_MONO_STACK,
    // ── 外壳 · 组件令牌（ui-common / ui-bookmarkbar / ui-navbar / ui-tabbar …）──
    '--hira-bg-surface': p.bg,
    '--hira-bg-elevated': p.surface,
    '--hira-bg-subtle': p.bgSubtle,
    '--hira-surface': p.solid,
    '--hira-surface-soft': p.surfaceSoft,
    /**
     * ⚠ `--hira-text-primary` 绑的是**浏览器 UI 的前景**（`colors.chromeFg`，
     * 默认 = `colors.fg`）：它被 navbar / tabbar / rail / 面板**及其组件**读取，
     * 而"内部页"（设置 / 历史 / 下载…）用的是 `--text`（= 内容前景）。
     *
     * ⚠⚠ **内容面必须把这根线剪断**：`--hira-text-primary` / `--text-color` 的名字
     * 太通用，跨场景共用件（ui-modal、通用列表…）自然会引用 —— 于是"只调浏览器 UI
     * 前景"会顺带改掉内部页 / 子窗口 / 弹窗的文字（用户明确指正过）。
     * 所以**内容面**在各自的令牌应用点上把它按回内容前景（= `--text`）：
     *   · 内部页 —— apps/app-main/src/pages/_shared/runtime.js#initTheme
     *   · 子窗口 —— apps/app-main/src/renderer/subwindow/index.html
     * 这两处是"内容面"的全部入口；浏览器 UI 侧一个字不动。
     * （主题编辑器的**预览子树**是例外：它显示的是草稿本身的 chromeFg，
     *   令牌直接写在子树根上，照样盖得住 —— 见 ui-panel-themes/window/preview.js。）
     */
    '--hira-text-primary': chromeFg,
    '--hira-text-secondary': p.textSoft,
    '--hira-text-tertiary': p.textMuted,
    '--hira-border-subtle': p.border,
    '--hira-accent': p.accent,
    '--hira-accent-bg': p.highlight,
    '--hira-accent-soft': p.accentSoft,
    /**
     * 软底之上再压一档（`--hira-accent-soft` 的 hover / 选中加深态）。
     * ⚠ 这条**以前没有产出**，只有 tokens-base.css 里的静态蓝色兜底 ——
     * 于是 panelKit 的 `.hp-btn--primary:hover`、`.hp-chip--active:hover`
     * 在任何主题下都是蓝的。凡"accent 的加强软底"都必须走这里。
     */
    '--hira-accent-soft-strong': withAlpha(p.accent, isDarkTheme(theme) ? 0.28 : 0.22),
    '--hira-hover-bg': p.hover,
    '--hira-field-bg': p.field,
    '--hira-field-bg-focus': p.fieldFocus,
    '--hira-track-bg': p.track,
    '--hira-switch-off': p.switchOff,
    '--hira-danger': p.danger,
    '--hira-danger-bg': p.dangerBg,
    '--hira-warn': p.warn,
    '--hira-warn-bg': p.warnBg,
    '--hira-success': p.success,
    '--hira-success-bg': p.successBg,
    /** accent 实底上的前景（开关滑块、复选勾、实心徽标）—— 由 accent 亮度算出来。 */
    '--hira-on-accent': p.onAccent,
    /**
     * 键盘焦点环。**值是 box-shadow 列表**（"0 0 0 2px 颜色"），只能喂给
     * `box-shadow`；要"颜色"请用下一条 `--hira-split-focus-ring`。
     * 以前没有产出 → 全仓 ~30 处焦点环永远停在 tokens-base.css 的静态蓝。
     */
    '--hira-focus-ring': `0 0 0 2px ${withAlpha(p.accent, isDarkTheme(theme) ? 0.6 : 0.45)}`,
    /**
     * 「活动面」框线**颜色**（分屏活动格 / 侧栏聚焦框 / 调宽把手）。
     * 与上一条严格分工：这里是颜色，可喂 border-color / background / color-mix()。
     */
    '--hira-split-focus-ring': withAlpha(p.accent, 0.9),

    // ── 外壳 · chrome 通用 hover/描边（tokens-base.css :root 里的那一对）──
    '--ui-border': p.border,
    '--ui-hover': p.hover,

    // ── 外壳 · 旧变量（ui-chrome-layout / ui-tabbar 仍直接引用）──
    // ⚠ `--main-bg-color` 是**chrome 的底色**，被 navbar → tabbar → 标签条这样
    // **多层嵌套**地引用（十来处）。带壁纸时把它设成"玻璃色"会出大问题：
    // 半透明层会**逐层叠加**（0.55 两层 ≈ 0.80），嵌套越深越不透明 ——
    // 于是标签条比地址栏深、rail 比面板深，正是要避免的"深浅不一"。
    // 所以这里给的是 **transparent**：所有 chrome 面自己都不再挡背景，
    // 真正的玻璃色由外壳**按区域各铺一片**（工具栏 / 内容洞 / 侧栏区），每片只有一层。
    // 附带好处：rail / 面板**是独立 WebContentsView**，它们自己的页面透明之后
    // 直接透出外壳已经铺好的那一片（内容洞那条 chrome 玻璃）—— 跨视图也一致。
    // （独立视图自己不能跨视图采 backdrop；外壳 chrome 层先把 UI 模糊合成好，
    //   透明视图随后透出的就是那份结果。）
    '--main-bg-color': chromeAlpha >= 1 ? p.bg : 'transparent',
    '--bg-color': p.solid,
    // UI 前景（chrome 图标与文字）：navbar / tabbar / rail / 标题栏 / 下载栏都读这几个。
    // 与内容前景（--text / --hira-text-* 的其它档）分家 —— 见 colors.chromeFg 的说明。
    '--text-color': chromeFg,
    '--no-main-font-color': chromeFg,
    '--sys-btn-font-color': chromeFg,
    '--new-tab-btn-font-color': chromeFg,
    '--tool-btn-color': chromeFg,
    '--border-color': p.border,
    '--main-border-color': p.border,
    '--accent-color': p.accent,
    '--accent-hover': p.accentHover,
    '--secondary-color': p.textSoft,
    '--secondary-hover': p.fg,
    '--badge-bg-color': p.accent,
    '--badge-font-color': p.onAccent,
    '--msg-icon-color': p.accent,

    // ── 外壳 · 网页容器的圆角/描边（网页自身的画布色固定白纸，不由主题给）──
    '--webview-border': p.border,

    // ── 外壳 · 下载栏的老 token（ui-download-bar 直接用这几个名字）──────────
    // 它们原先只有**硬编码浅色**兜底（`var(--downloadbar-bg, #f5f5f5)`），
    // 于是深色主题下下载栏是一块白 —— 属"没接进主题体系"的那一类色块。
    // 这里按 §6.2 第 4 条的判据映射：栏体是 **chrome**（用玻璃色），
    // 弹出面板是**内容**（用不透明的抬升面），其余取调色板对应槽位。
    '--downloadbar-bg': chromeBg,
    '--panel-bg': p.solid,
    '--progress-bg': p.track,
    '--list-hover-bg': p.hover,
    '--button-hover-bg': p.hover,
    '--accent-primary': p.accent,
    '--accent-primary-hover': p.accentHover,
    '--surface-muted': p.surfaceSoft,

    // ── 内部页（hira:// · _shared/base.css）──
    '--bg': p.bg,
    '--surface': p.solid,
    '--surface-solid': p.solid,
    '--surface-soft': p.surfaceSoft,
    '--border': p.border,
    '--border-strong': p.borderStrong,
    '--text': p.fg,
    '--text-soft': p.textSoft,
    '--text-muted': p.textMuted,
    '--accent': p.accent,
    '--accent-strong': p.accentHover,
    '--danger': p.danger,
    /**
     * 内部页的焦点色。走 **accent** 而不是内容前景 —— 焦点环是"强调"语义，
     * 与 `--hira-focus-ring` 同源，才不会有"面板里环是主题色、内部页里环是灰色"。
     */
    '--focus': withAlpha(p.accent, isDarkTheme(theme) ? 0.45 : 0.35),

    // ── 新标签页 ──
    '--ntp-bg': p.bg,
    '--ntp-text': p.fg,
    '--ntp-text-soft': p.textSoft,
    '--ntp-border': p.border,
    '--ntp-hover': p.hover,
    '--ntp-accent': p.accent,

    // ── 主题自身的可消费参数（chrome 的透明度 / 模糊 / 对比度 / 圆角）──
    '--hira-theme-transparency': String(style.transparency),
    /** 兼容旧消费方；新代码请使用语义更明确的 --hira-ui-blur。 */
    '--hira-theme-blur': `${style.blur}px`,
    '--hira-theme-contrast': String(style.contrast),
    '--hira-theme-radius': `${style.cornerRadius}px`,
    /**
     * 圆角阶梯的**步长**（px）—— 网页之外的表层按 `r ± N 步` 取整数档
     * （见 shared-ui-tokens#tokens-base.css 的 --hira-radius-*）。
     *
     * 为什么是"加"而不是按比例：比例会在圆角调大时翻倍（r=12 时 1.17× 就多出 2px），
     * 用户口径是"同样数值下比网页那圈大 1px"—— 所以步长恒为 1px。
     * 圆角为 0 时必须同时归零：否则 `r + 1px` 会让"全身直角"的主题里多出 1px 小圆角。
     */
    '--hira-radius-step': style.cornerRadius > 0 ? '1px' : '0px',
    '--hira-theme-colorize': style.colorizeMode,
    /**
     * 窗口材质 id（`none` / `acrylic` / `mica`）。渲染层用它给外壳挂"材质态"样式
     * （例如在这种态下允许更透的玻璃底），**原生窗口材质本身不在这里开** ——
     * 那一步只有主进程能做（见 infra-window/src/backdrop）。
     */
    '--hira-theme-material': style.material,

    // ── chrome 玻璃（语义别名，值就是上面那个 --main-bg-color）──────────
    // 新代码建议用这三个名字（语义明确）；`--hira-chrome-bg` 与 `--main-bg-color`
    // 是同一个值 —— 保留旧名是因为 navbar/tabbar/rail 等十来处仍在引用它。
    '--hira-chrome-bg': chromeBg,
    /** 浏览器 UI 的前景色（= colors.chromeFg）—— 需要单独取用时用它。 */
    '--hira-chrome-fg': chromeFg,
    /**
     * **面板**（下载 / 历史 / 书签…）这一档的独立前景 —— 未设时为 UI 前景。
     *
     * 消费方：ui-common#injectPanelStyles 在面板子树根上把三档文字色按它重算
     * （`--hira-text-primary/secondary/tertiary`），于是面板里**共享组件**也一起跟上，
     * 不必逐个组件去接 —— 一处声明、整棵子树生效。
     * soft / muted 两档只在作者**显式设过** panelFg 时才由它派生（本色降透明度）；
     * 没设就照主题原本那两档 ⇒ 默认逐字不变。
     */
    '--hira-panel-fg': panelFg,
    '--hira-panel-fg-soft': panelFgSet ? `color-mix(in srgb, ${panelFg} 72%, transparent)` : p.textSoft,
    '--hira-panel-fg-muted': panelFgSet ? `color-mix(in srgb, ${panelFg} 55%, transparent)` : p.textMuted,
    /** **独立侧栏（网页浏览）标题栏**的独立前景 —— 口径与 --hira-panel-fg 完全相同。 */
    '--hira-web-sidebar-fg': wsHeaderFg,
    '--hira-web-sidebar-fg-soft': wsHeaderFgSet ? `color-mix(in srgb, ${wsHeaderFg} 72%, transparent)` : p.textSoft,
    '--hira-web-sidebar-fg-muted': wsHeaderFgSet ? `color-mix(in srgb, ${wsHeaderFg} 55%, transparent)` : p.textMuted,
    /**
     * **面板**自己那一层（下载 / 历史 / 书签…）的底色 —— 强度独立。
     *
     * 落点在**面板的视图**里（ui-common#injectPanelStyles 的 `#root`），不是外壳：
     * 面板是独立 WebContentsView，跨视图拿不到外壳那层玻璃，所以它自己铺一层。
     * ⚠ 只作用于**面板**：rail 与侧栏区（垂直标签栏）属 chrome UI，走 --hira-chrome-bg。
     * ⚠ 也没有配套的"面板模糊"：面板背后的模糊来自它下面那层外壳 UI 玻璃
     * （见 --hira-ui-blur），跨视图的单层 backdrop-filter 在 Chromium 里拿不到东西。
     */
    '--hira-panel-bg': panelBg,
    /** chrome 自身底色的不透明度（1 = 完全挡住背景）。给需要"算比它更透一层"的场景。 */
    '--hira-chrome-alpha': String(chromeAlpha),
    /**
     * UI 玻璃层模糊（Vivaldi 的 "Blur"）。
     *
     * 落点是外壳的 chrome 区域，**不碰壁纸层本身**。面板 / 新标签页是透明视图，
     * 看到的是外壳 UI 玻璃层合成后的结果；壁纸自己的模糊由 background.blur 独立控制。
     * 下限 MIN_UI_BLUR 只属于这一层，不能拿来夹取背景参数。
     */
    '--hira-ui-blur': `${style.blur}px`,
    /** 旧名兼容：历史样式仍引用 --hira-chrome-blur。 */
    '--hira-chrome-blur': `${style.blur}px`
  }

  return tokens
}

/**
 * 令牌表 → 一段 CSS 文本（给 `webContents.insertCSS` 用）。
 *
 * 为什么需要它：`insertCSS` 只吃文本。主进程要往**已经加载完成的**内部页/外壳补注主题
 * （页面还没接上 `theme:tokens` 时的兜底路径），此时没有渲染层的 `setProperty` 可用。
 *
 * @param {Record<string, string>} tokens
 * @param {string} [selector] 作用域，默认 `:root`
 */
function themeTokensToCss(tokens: Record<string, string>, selector: string = ':root'): string {
  const body = Object.entries(tokens || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `${selector} {\n${body}\n}\n`
}

/**
 * 背景段 → 可直接写进 `style.background*` 的属性组。
 *
 * `assetUrl` 由调用方给出（主进程/渲染层各自知道怎么把主题里的相对路径
 * 变成 `hira-plugin://…` / `hira-theme://…` 这样的可加载 URL）—— 本函数**不认识任何协议**。
 *
 * `dailyUrl` 是「每日一图」**已经取到**的远程地址。取图是异步的（要联网），
 * 而本函数必须保持同步纯函数 —— 所以由调用方（theme-service）把缓存里的地址传进来，
 * 拿不到就传空串（此时不落图，页面露出主题自己的底色，拉到之后会重发一次广播）。
 *
 * @param {any} backgroundRaw
 * @param {string} [assetUrl]  图片主题的资产地址（插件主题 / 用户主题各自的协议）
 * @param {string} [dailyUrl]  「每日一图」已取到的远程地址
 * @returns {{ backgroundImage: string, backgroundSize: string, backgroundPosition: string, backgroundRepeat: string, opacity: string, blur: string, overlayColor: string }}
 */
export interface ThemeBackgroundCss {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
  backgroundRepeat: string
  opacity: string
  blur: string
  overlayColor: string
}

function themeBackgroundCss(backgroundRaw: unknown, assetUrl = '', dailyUrl = ''): ThemeBackgroundCss {
  const bg = normalizeThemeBackground(backgroundRaw)
  /** @type {{ image: string, size: string, position: string, repeat: string }} */
  let layer: { image: string, size: string, position: string, repeat: string } = { image: '', size: 'auto', position: 'center', repeat: 'no-repeat' }

  /**
   * 「照片型」背景 —— 图片主题与**每日一图**共用同一条落图口径：都是"一张位图铺满"。
   * 两者的差别只有**地址从哪来**：图片主题来自主题资产（本地），每日一图来自网络。
   * 合成一个 `photoUrl` 而不是各写一个分支，是为了让下面那条 `position` 口径也天然共用
   *（拆成两处写，"每日一图改不了铺法"这种不一致迟早出现）。
   *
   * ⚠ **视频（`kind:'video'`）刻意不在这里**：`background-image` 表达不了视频。
   * 它在 `themeBackgroundStyle` 里走 `mode:'video'` + `videoSrc`，由渲染侧那条
   * 共享的背景层渲染器放一个 `<video>`（见 shared-types/src/theme-background.mjs）。
   */
  const photoUrl = bg.kind === 'image' ? assetUrl : (bg.kind === 'daily' ? dailyUrl : '')

  if (photoUrl) {
    layer = { image: `url("${photoUrl}")`, size: 'cover', position: 'center', repeat: 'no-repeat' }
  } else if (bg.kind === 'css' && bg.css) {
    layer = { image: bg.css, size: 'auto', position: 'center', repeat: 'no-repeat' }
  } else if (bg.kind === 'color' && bg.color) {
    layer = { image: 'none', size: 'auto', position: 'center', repeat: 'no-repeat' }
  }

  /** 位置口径 → size/position/repeat 三元组（与 CSS 的 `background-*` 语义一一对应）。 */
  if (photoUrl) {
    if (bg.position === 'contain') layer = { ...layer, size: 'contain', position: 'center', repeat: 'no-repeat' }
    else if (bg.position === 'center') layer = { ...layer, size: 'auto', position: 'center', repeat: 'no-repeat' }
    else if (bg.position === 'tile') layer = { ...layer, size: 'auto', position: 'top left', repeat: 'repeat' }
    else if (bg.position === 'stretch') layer = { ...layer, size: '100% 100%', position: 'center', repeat: 'no-repeat' }
  }

  /**
   * 遮罩 = **颜色 × 浓度**（两件事必须各自独立生效）。
   *
   *   `resolveVeilColor` 决定遮罩是什么色（没显式给就是白 —— 见那里的说明）；
   *   `overlay` 决定浓度（0~1），**始终**作为 alpha。
   *
   * ⚠ 早期实现有两处坑，都已修：
   *   ① "显式给了 overlayColor 就直接用它（alpha=1）"→ 选了白色、浓度拉到 0
   *      仍会盖出一片不透明纯白；
   *   ② 没给色时回落到"背景色"→ 深色主题下生效的是近黑色，而编辑器显示白，
   *      于是"调不透明度没反应"。
   */
  return {
    backgroundImage: layer.image,
    backgroundSize: layer.size,
    backgroundPosition: layer.position,
    backgroundRepeat: layer.repeat,
    opacity: String(bg.opacity),
    blur: `${bg.blur}px`,
    overlayColor: withAlpha(resolveVeilColor(bg), bg.overlay) || 'transparent'
  }
}

/**
 * 背景段 → **某一应用面**上的最终样式（可直接逐项赋给 `style.*`）。
 *
 * 为什么要按面（scope）算、并且由主进程算好：三套消费面里有两套（外壳、内部页）
 * 的代码形态完全不同 —— 内部页是**未打包的普通 ESM**，连共享层都 import 不到。
 * 如果"这个背景该不该显示、显示成什么样"由各渲染方自己判，那就是三份会漂移的规则
 * （典型症状：窗口上有背景、新标签页上没有，或反之）。所以判据只有这一处。
 *
 * ⚠ `mode` 是**画法的开关**（不是"有没有背景"——那是 `visible`）：
 *   · `'css'`  —— 走 `background-image` 三元组（图片 / 渐变 / 纯色）；
 *   · `'video'` —— 渲染侧要在容器里放一个 `<video>`，`videoSrc` 才是它的地址
 *     （此时 `backgroundImage` 一定是 `none`，两者**互斥**，不要同时用）；
 *   · `'none'` —— 什么也不画。
 * 四个消费面共用同一个渲染器（`shared-types/src/theme-background.mjs`）读这三个值，
 * 所以"怎么画"这件事同样只有一处。
 *
 * @param {any} backgroundRaw `theme-background` 形状（已归一化或来自 IPC 载荷）
 * @param {'window'|'newtab'} scope
 * @returns {{ visible: boolean, mode: 'none'|'css'|'video', videoSrc: string,
 *             backgroundImage: string, backgroundSize: string, backgroundPosition: string,
 *             backgroundRepeat: string, opacity: string, filter: string, overlayColor: string }}
 */
function themeBackgroundStyle(backgroundRaw: unknown, scope: 'window' | 'newtab' = 'newtab') : { visible: boolean, mode: 'none'|'css'|'video', videoSrc: string,
            backgroundImage: string, backgroundSize: string, backgroundPosition: string,
            backgroundRepeat: string, opacity: string, filter: string, overlayColor: string } {
  const bg = normalizeThemeBackground(backgroundRaw)
  const applyTo = Array.isArray(bg.applyTo) ? bg.applyTo : []
  const target = scope === 'window' ? 'window' : 'newtab'
  const visible = applyTo.indexOf(target) >= 0 && !!bg.kind && bg.kind !== 'none'
  const mode = !visible ? 'none' : (bg.kind === 'video' ? 'video' : 'css')
  return {
    visible,
    mode,
    videoSrc: mode === 'video' ? bg.videoSrc || '' : '',
    backgroundImage: mode === 'css' ? bg.backgroundImage || 'none' : 'none',
    backgroundSize: visible ? bg.backgroundSize || 'auto' : 'auto',
    backgroundPosition: visible ? bg.backgroundPosition || 'center' : 'center',
    backgroundRepeat: visible ? bg.backgroundRepeat || 'no-repeat' : 'no-repeat',
    opacity: visible && bg.opacity != null ? String(bg.opacity) : '1',
    filter: visible && bg.blur > 0 ? `blur(${bg.blur}px)` : '',
    overlayColor: visible && bg.overlayColor ? bg.overlayColor : 'transparent'
  }
}

export {
  // 常量
  THEME_SETTING_KEYS,
  THEME_MODES,
  THEME_MODE_LABELS,
  normalizeThemeMode,
  themeModeLabel,
  THEME_SCHEDULE_MODES,
  BACKGROUND_KINDS,
  BACKGROUND_ASSET_KINDS,
  BACKGROUND_POSITIONS,
  BACKGROUND_APPLY_TARGETS,
  COLORIZE_MODES,
  WINDOW_MATERIALS,
  WINDOW_MATERIAL_LABELS,
  BUILTIN_THEME_IDS,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_IDS,
  LEGACY_THEME_ID_MAP,
  THEME_SOURCES,
  USER_THEME_ID_PREFIX,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
  DEFAULT_STYLE,
  DEFAULT_BACKGROUND,
  DEFAULT_OVERLAY_COLOR,
  // 颜色工具
  parseColor,
  colorToCss,
  withAlpha,
  mixColor,
  relativeLuminance,
  readableTextOn,
  // 归一化与解析
  normalizeTheme,
  normalizeThemeBackground,
  normalizeThemeSchedule,
  normalizeHour,
  isNightNow,
  resolveVeilColor,
  // chrome（浏览器 UI）玻璃的两个旋钮 + "是否该玻璃"的唯一判据
  glassesWindow,
  // 窗口材质（亚克力等）：判据与规格。玻璃面 = 有壁纸 或 有窗口材质（glassSurface）
  hasWindowMaterial,
  glassSurface,
  windowMaterialSpec,
  resolveChromeOverlay,
  resolveChromeOverlayColor,
  resolveChromeFg,
  resolvePanelFg,
  resolveWebSidebarFg,
  // 「自动前景」：哨兵值 + 允许它的那几档 + 判定函数（编辑器与主进程共用同一条规则）
  AUTO_FG,
  AUTO_FG_KEYS,
  autoFgFor,
  resolvePanelOverlay,
  clamp01,
  isDarkTheme,
  isUserThemeId,
  createUserTheme,
  legacyActiveTheme,
  derivePalette,
  // 令牌（唯一产出点）
  themeToTokens,
  themeTokensToCss,
  themeBackgroundCss,
  themeBackgroundStyle
}

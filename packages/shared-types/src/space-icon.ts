/**
 * 空间图标 —— **唯一真源**（id 白名单 / 别名表 / 归一化 / 默认分配）
 *
 * ── 为什么必须落在 shared-types ──────────────────────────────────────────
 * 这条规则同时被**三个进程/层**用到，而它们互相之间不能依赖：
 *   · domain（Node CJS）：`domain/domain-space` 写库前校验 + 兜底；
 *   · 渲染层 / 内部页（ESM）：`pages/_shared/icons.js` 画图标、`pages/spaces` 出选择器；
 *   · 构建期（Node CJS）：`electron.vite.config.js` 同步给 `hira://shared/`。
 * domain 不允许 require apps，页面又不能 import apps —— 所以只能放在最底层的
 * 纯数据模块里（与 `page-icon.mjs` / `favicon-src.mjs` 同一口径）。
 *
 * ── 这里只有「id 语义」，没有「画法」───────────────────────────────────
 * SVG 路径数据留在 `apps/app-main/src/pages/_shared/icons.js`（渲染层资产）；
 * 本文件只回答三件事：哪些 id 合法、历史值怎么归一到合法 id、新空间给哪个图标。
 *
 * ── 兼容历史值 ──────────────────────────────────────────────────────────
 * 旧库（RT）存的是 Carbon 类名 `carbon:home` / 旧 unicode `◈` / 中文别名。
 * 别名表把它们统一映射到规范 id，**不需要写迁移脚本**：
 * 读的时候归一、写的时候落规范值，脏数据自然收敛。
 */

/**
 * 可选空间图标（选择器展示顺序）—— id 同时是 DB `space.icon` 的存储值。
 * 与渲染层 `SPACE_PATHS` 的键**逐字一致**（路径数据在那边）。
 */
export const SPACE_ICON_IDS = Object.freeze([
  'home', 'user', 'users', 'layout', 'folder', 'book',
  'education', 'game', 'palette', 'music', 'cart', 'wallet',
  'plane', 'rocket', 'globe', 'tent', 'settings', 'lock',
  'bulb', 'star', 'fire', 'cloud', 'growth', 'document',
  'laptop', 'incognito', 'diamond', 'circle', 'square', 'triangle',
  'sun', 'coffee', 'zap', 'sparkles', 'flower'
])

/** 渲染兜底：空值 / 未知值画这一颗（与 navbar「Spaces」面板同形）。 */
export const DEFAULT_SPACE_ICON = 'layout'

/** 默认空间（id='default'）的图标：语义是「首页」。 */
export const DEFAULT_SPACE_HOME_ICON = 'home'

const ICON_SET = new Set(SPACE_ICON_IDS)

/**
 * 历史值兼容表：carbon:* 遗留名、旧 unicode 字符、语义别名（含中文）→ 规范 id。
 * 键区分大小写地查一次、再小写查一次；`carbon:` 前缀另有兜底剥离。
 */
/** @type {Readonly<Record<string, string>>} */
export const SPACE_ICON_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'carbon:home': 'home',
  'carbon:user': 'user',
  'carbon:user-multiple': 'users',
  'carbon:workspace': 'layout',
  'carbon:folder': 'folder',
  'carbon:book': 'book',
  'carbon:education': 'education',
  'carbon:game-console': 'game',
  'carbon:paint-brush': 'palette',
  'carbon:music': 'music',
  'carbon:shopping-cart': 'cart',
  'carbon:wallet': 'wallet',
  'carbon:flight-international': 'plane',
  'carbon:rocket': 'rocket',
  'carbon:earth': 'globe',
  'carbon:campsite': 'tent',
  'carbon:settings': 'settings',
  'carbon:locked': 'lock',
  'carbon:idea': 'bulb',
  'carbon:star': 'star',
  'carbon:fire': 'fire',
  'carbon:cloudy': 'cloud',
  'carbon:growth': 'growth',
  'carbon:document': 'document',
  'carbon:laptop': 'laptop',
  'carbon:view-off': 'incognito',
  '◈': 'layout',
  '⌂': 'home',
  '★': 'star',
  '◆': 'diamond',
  '●': 'circle',
  '■': 'square',
  '▲': 'triangle',
  '☀': 'sun',
  '☁': 'cloud',
  '☕': 'coffee',
  '⚡': 'zap',
  '✦': 'sparkles',
  '✿': 'flower',
  '♫': 'music',
  '⚙': 'settings',
  '☯': 'circle',
  house: 'home',
  主页: 'home',
  workspace: 'layout',
  grid: 'layout',
  earth: 'globe',
  gamepad: 'game',
  pencil: 'palette',
  paint: 'palette',
  bulb: 'bulb',
  idea: 'bulb',
  private: 'incognito'
})

/**
 * 任意值 → 规范 id；**无法识别返回 ''**（调用方据此决定「忽略这次写入」）。
 *
 * 与 `resolveSpaceIconId` 的区别只有一个：这里保留"非法"这一信息，
 * 供 domain 的 merge（非法值不覆盖已有值）与 UI 的绘制兜底分别使用。
 *
 * @param {*} value
 * @returns {string} 规范 id 或 ''
 */
export function normalizeSpaceIcon(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (ICON_SET.has(lower)) return lower
  if (ICON_SET.has(raw)) return raw
  if (SPACE_ICON_ALIASES[raw]) return SPACE_ICON_ALIASES[raw]
  if (SPACE_ICON_ALIASES[lower]) return SPACE_ICON_ALIASES[lower]
  if (lower.startsWith('carbon:')) {
    const short = lower.slice(7)
    if (ICON_SET.has(short)) return short
    if (SPACE_ICON_ALIASES[short]) return SPACE_ICON_ALIASES[short]
  }
  return ''
}

/**
 * 任意值 → 规范 id（**永不返回空**，未知/空值退 `DEFAULT_SPACE_ICON`）。
 * 渲染层用它画图：脏数据也能画出图标，不会出现"空白方块"。
 *
 * @param {*} value
 * @returns {string}
 */
export function resolveSpaceIconId(value: unknown) : string {
  return normalizeSpaceIcon(value) || DEFAULT_SPACE_ICON
}

/** FNV-1a 32 位：稳定的字符串散列（同一 id 永远得到同一颗图标）。 */
/** @param {string} input */
function hashSeed(input: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * 新空间的默认图标分配。
 *
 * 规则（对齐 RT `getDefaultProfileIcon` 的意图：可复现、不用随机数）：
 *   · 默认空间 → `home`（它是"首页"）；
 *   · 其它空间 → 用 id 做稳定散列，在**全部**可选图标里挑一颗。
 *     同一 id 每次得到的结果相同，因此重装 / 导入 / 多次读取都不会跳图标。
 *
 * @param {string} [seed] 空间 id（缺省时退回 index）
 * @param {number} [index] 列表下标（无 id 可用的导入场景）
 * @returns {string} 规范 id
 */
export function defaultSpaceIcon(seed: string = '', index: number = 0) : string {
  const s = typeof seed === 'string' ? seed.trim() : ''
  if (s === 'default') return DEFAULT_SPACE_HOME_ICON
  const key = s || String(index)
  return SPACE_ICON_IDS[hashSeed(key) % SPACE_ICON_IDS.length]
}

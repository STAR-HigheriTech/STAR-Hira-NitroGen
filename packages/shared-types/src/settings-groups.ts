/**
 * 设置「大类」（侧栏 rail 的分组）—— **唯一真源**。
 *
 * 谁在读它：
 *   · 主进程 `apps/app-main/src/main/settings/registry.js`
 *     —— 注册期校验 `group`、`getSchema()` 按这里的顺序排序并写入 `groupLabel` / `groupIcon`；
 *   · 内部页外壳 `apps/app-main/src/pages/_shared/shell-registry.mjs`
 *     —— 同名分组的标题从这里派生（不再手抄中文名）；
 *   · 插件贡献的设置分区（`main/settings/ipc.js#collectPluginSections`）
 *     —— 只接受这里的 id，未知分组不会被静默塞进某个角落。
 *
 * ⚠ 新增一个分区时，`group` **只能**填下面 8 个 id 之一。
 *   想加一个新大类？先在这里加一行（id / label / icon 三件套），再改分区。
 *   不准再把中文组名直接写进 `registerSection({ group: '外观' })` ——
 *   那正是「设置页一套词表、内部页另一套词表」漂移的起点。
 */

import { pageUrl } from './page-url.js'

export interface SettingsGroup {
  id: string
  label: string
  icon: string
  href?: string
}

/**
 * 顺序 = 设置页 rail 的导航顺序。
 * `icon` 是设置页 `ICONS` 表里的字形名（settings.js），不是 emoji / 文件路径。
 *
 * `href`（可选）= 这一项**不是设置分区，而是一扇门**：点它直接跳到那个内部页，
 * 不再切内容区。设置页因此不需要认识「关于」这件事 —— 新增跳转型大类只改这一行。
 * 地址拼法走 `page-url.mjs#pageUrl()`：它是零依赖原语，不会与本文件成环。
 * @type {ReadonlyArray<SettingsGroup>}
 */
export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroup> = Object.freeze(
  [
    { id: 'appearance', label: '外观', icon: 'palette' },
    { id: 'search', label: '搜索引擎', icon: 'search' },
    { id: 'startup', label: '启动与行为', icon: 'window' },
    { id: 'privacy', label: '隐私与安全', icon: 'shield' },
    { id: 'extensions', label: '扩展与插件', icon: 'puzzle' },
    { id: 'tools', label: '工具', icon: 'sliders' },
    { id: 'system', label: '系统与数据', icon: 'layers' },
    // 关于 /= 设置分区：版本 / 运行时 / 更新本来就在 hira://about 那一个页里，
    // 点这里只是把用户送过去 —— 不在设置页再长一份同名界面。
    { id: 'about', label: '关于 Hira', icon: 'info', href: pageUrl('about') }
  ].map((group) => Object.freeze(group))
)

/** 组 id 的导航顺序（`registerSection` / `getSchema` 的排序依据）。 */
export const SETTINGS_GROUP_ORDER = Object.freeze(SETTINGS_GROUPS.map((g) => g.id))

const BY_ID = new Map(SETTINGS_GROUPS.map((g) => [g.id, g]))

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSettingsGroup(id: unknown) : boolean {
  return BY_ID.has(String(id == null ? '' : id))
}

/**
 * @param {unknown} id
 * @returns {SettingsGroup | null}
 */
export function settingsGroup(id: unknown) : SettingsGroup | null {
  return BY_ID.get(String(id == null ? '' : id)) || null
}

/**
 * 组 id → 中文标题。未知 id 原样返回（插件自建的分组靠这条兜底显示）。
 * @param {unknown} id
 * @returns {string}
 */
export function settingsGroupLabel(id: unknown) : string {
  const group = settingsGroup(id)
  return group ? group.label : String(id == null ? '' : id)
}

/**
 * 组 id → 设置页字形名。未知 id 返回空串（调用方自行退回兜底图标）。
 * @param {unknown} id
 * @returns {string}
 */
export function settingsGroupIcon(id: unknown) : string {
  const group = settingsGroup(id)
  return group ? group.icon : ''
}

/**
 * 组 id → 跳转地址（只有「门」型大类有；普通分区返回空串）。
 * 设置页据此决定这一项是切内容区，还是直接 `location.href = href`。
 * @param {unknown} id
 * @returns {string}
 */
export function settingsGroupHref(id: unknown) : string {
  const group = settingsGroup(id)
  return group && group.href ? group.href : ''
}

/**
 * 把任意输入归一成合法组 id：
 *   · 合法 id   → 原样；
 *   · 中文标题 → 对应 id（容错：老代码 / 插件写的是 `'外观'`）；
 *   · 其余      → 空串（调用方决定警告 / 落到兜底分组）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSettingsGroup(value: unknown) : string {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  if (BY_ID.has(raw)) return raw
  for (const group of SETTINGS_GROUPS) if (group.label === raw) return group.id
  return ''
}

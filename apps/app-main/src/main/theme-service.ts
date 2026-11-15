/**
 * theme-service.js —— 主进程侧的主题**目录与状态**（唯一主题状态源）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它管什么、不管什么
 * ══════════════════════════════════════════════════════════════════════
 *   管：主题目录（内置 + 插件来源）、当前主题 id、着色解析、订阅、旧值迁移。
 *   不管：把颜色画到界面上（那是渲染层的 theme-controller 与内部页 runtime）、
 *         原生窗口表面色（theme-runtime 调 layout.setTabTheme）、
 *         系统外观监听与广播（theme-runtime）。
 *
 * 这条边界让"换主题"与"主题长什么样"分家：前者是状态，后者是数据。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么目录要合并**四个**来源，且内置优先
 * ══════════════════════════════════════════════════════════════════════
 *   ① 内置主题（`theme-builtins.js`，代码里写死）—— 插件体系整体起不来时界面仍有配色；
 *   ② 插件**声明式**主题（manifest `contributes.themes`，**纯数据、零代码**）——
 *      这正是"主题即插件"的主路径：主题作者只写一份 manifest，与装一个插件同链路；
 *   ③ 插件**计算式**主题（`theme.source` 插槽）—— 需要运行时才算得出的主题
 *      （从当前网页取强调色、随时间渐变的动态主题…）；
 *   ④ 后处理（`theme.decorator` 插槽）—— 社区 Mod 可整体改写任何主题（降饱和、夜间压暗）。
 *
 * ②③ 是**同一件事的两种形态**（静态数据 / 动态计算），故合并进同一个 `pluginThemes`，
 * 对下游只暴露"主题目录"这一个概念 —— 消费者不需要知道某条主题来自哪种形态。
 * **内置 id 不可被插件顶掉**：否则"恢复默认主题"会失效，而且用户会得到一个
 * 与出厂完全不同的"浅色"。撞 id 的插件主题直接忽略并告警。
 *
 * 颜色到令牌的映射**不在本文件**：唯一真源是 `shared-types/src/theme.mjs#themeToTokens`
 * （主进程、外壳、内部页、新标签页必须读到同一份，所以它只能在那里）。
 */

import {
  THEME_SETTING_KEYS,
  DEFAULT_THEME_ID,
  USER_THEME_ID_PREFIX,
  normalizeTheme,
  normalizeThemeSchedule,
  legacyActiveTheme,
  isDarkTheme,
  isUserThemeId,
  createUserTheme,
  themeToTokens,
  themeTokensToCss,
  themeBackgroundCss,
  themeBackgroundStyle,
  BACKGROUND_ASSET_KINDS,
  type ThemeData
} from '@hira-ng/shared-types/src/theme.mjs'
const { BUILTIN_THEMES } = require('./theme-builtins')
const { createThemeLuminance } = require('./theme-luminance')

interface ThemeSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): Promise<unknown> | unknown
}

interface ThemeContributionsPort { list(kind: string): unknown }
interface ThemeExtensionPointsPort { call(name: string, context: unknown): Promise<unknown> | unknown; isDefined(name: string): boolean }
interface ThemeAssetPort { url?(id: string, rel?: string): string; read?(id: string, rel?: string): Promise<Buffer | null> }
interface DailyBackgroundPort { get?(): string; ensure?(): Promise<string>; bytes?(url: string): Promise<Buffer | null> }
interface ThemeLogger { warn?(...args: unknown[]): void; info?(...args: unknown[]): void }

export interface ThemeServiceDependencies {
  settings?: ThemeSettingsPort | null
  extensionPoints?: ThemeExtensionPointsPort | null
  pluginAssets?: ThemeAssetPort | null
  userAssets?: ThemeAssetPort | null
  dailyBackground?: DailyBackgroundPort | null
  contributions?: ThemeContributionsPort | null
  logger?: ThemeLogger
}

interface ThemeChange { topic: string; id: string }
type ThemeBackgroundSource =
  | { kind: 'remote'; id: string; url: string }
  | { kind: 'plugin'; id: string; pluginId: string; path: string }
  | { kind: 'user'; id: string; path: string }
interface ThemeLuminancePort { peek(key: string): number | null; ensure(key: string, load: () => Promise<Buffer | null>, onReady: () => void): void }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 *   settings?: { get: Function, set: Function },
 *   extensionPoints?: object,
 *   pluginAssets?: { url?: (pluginId: string, rel: string) => string, read?: (pluginId: string, rel: string) => Promise<Buffer|null> },
 *   userAssets?: { url?: (key: string) => string, read?: (key: string) => Promise<Buffer|null> },
 *   dailyBackground?: { get?: () => string, ensure?: () => Promise<string>, bytes?: (url: string) => Promise<Buffer|null> },
 *   logger?: { warn?: Function, info?: Function }
 * }} [deps]
 */
export function createThemeService(deps: ThemeServiceDependencies = {}) {
  const settings = deps.settings || null
  const extensionPoints = deps.extensionPoints || null
  /**
   * 插件资产的两个口：`url()` 拼 `hira-plugin://` 地址（主题包里的背景图要用它）。
   *
   * 为什么由 APPS 注入而不是这里 require `plugin-protocol`：URL **形状**是协议层与
   * 消费方之间的契约（见 plugin-protocol.js#buildPluginAssetUrl 的说明），两处各写
   * 一份必然漂移；而本文件刻意不 require electron（它是可单测的纯逻辑）。
   */
  const pluginAssets = deps.pluginAssets || null
  /**
   * **用户主题**的图片资产口（`hira-theme://`）。与 `pluginAssets` 分成两口而不是合成
   * 一个"通道"，是因为两者的安全边界不同（一个能下发代码、一个只发图片）——
   * 见 theme-asset-protocol.js 文件头。这里只当"key → URL"用。
   */
  const userAssets = deps.userAssets || null
  /**
   * 「每日一图」的取图器（Bing 每日壁纸）。本服务只**同步读缓存**，
   * 拉取与缓存策略全在那个盒子里（见 theme-daily.js）。
   */
  const dailyBackground = deps.dailyBackground || null
  const logger = deps.logger || console

  /**
   * 壁纸**平均亮度**的测量器（「自动前景」的唯一数据来源）。
   *
   * 分工：本服务负责"这份主题的背景图从哪来"（资产库 / 每日一图），
   * `theme-luminance` 只负责"解码 + 求平均 + 按图片身份缓存"——
   * 于是它不认识资产库、也不认识网络，可以单独喂字节测。
   */
  const wallpaperLuminance = createThemeLuminance({ logger }) as ThemeLuminancePort

  /**
   * 声明式贡献注册表（`contributes.themes` 落在这里）。
   *
   * **为什么是晚绑定**：主题服务必须在建窗之前就 `prime()`（否则首屏会闪一下），
   * 而贡献注册表由 main.js 更晚才建出来（它还要被面板目录共用）。用 setter 注入，
   * 既保住启动顺序，又不必为一个读取口把整条组合根顺序重排。
   */
  let contributions = deps.contributions || null

  /** 插件来源的主题（声明式 `contributes.themes` + 计算式 `theme.source` 的合并）。 */
  let pluginThemes: Array<Record<string, unknown>> = []
  /** id → 归一化后的主题。 */
  const byId = new Map<string, ThemeData>()
  /** 当前目录对应的 profile；用户主题按 profile 隔离，切 profile 必须重建。 */
  let catalogScopeKey = ''

  function currentCatalogScopeKey(): string {
    const s = settings as (ThemeServiceDependencies['settings'] & { currentProfile?(): string }) | null
    try { return s && typeof s.currentProfile === 'function' ? String(s.currentProfile() || 'default') : 'default' } catch (_) { return 'default' }
  }
  /** 同一 profile 内复用目录；profile 一变，立即按目标覆盖层重建用户主题。 */
  function ensureCatalogForScope(): void {
    const next = currentCatalogScopeKey()
    if (next === catalogScopeKey) return
    catalogScopeKey = next
    rebuild()
    emit('catalog', '')
  }
  /** @type {Set<(change: { topic: string, id: string }) => void>} */
  const listeners: Set<(change: { topic: string, id: string }) => void> = new Set<(change: ThemeChange) => void>()

  function emit(topic: string, id: string): void {
    for (const fn of Array.from(listeners)) {
      try {
        fn({ topic, id })
      } catch (e) {
        logger.warn?.('[theme] 订阅者抛错：', errorMessage(e))
      }
    }
  }

  /** 用当前三个来源重建目录（内置 > 用户 > 插件）。 */
  function rebuild(): void {
    byId.clear()
    for (const raw of BUILTIN_THEMES) {
      const theme = normalizeTheme({ ...raw, source: 'builtin' })
      if (theme.id) byId.set(theme.id, theme)
    }
    // ── 用户主题（编辑器保存的成果）────────────────────────────────────
    // 排在插件之前：同一个 id 上，用户自己建的那份应当压住插件带来的那份
    // （否则"我改好的主题被一个插件顶掉了"）。内置仍在最前 —— 出厂主题不可被顶掉。
    for (const raw of readUserThemes()) {
      const theme = normalizeTheme({ ...(raw || {}), source: 'user' })
      if (!theme.id || byId.has(theme.id)) continue
      byId.set(theme.id, theme)
    }
    for (const raw of pluginThemes) {
      const theme = normalizeTheme({ ...(raw || {}), source: (raw && raw.source) || 'plugin' })
      if (!theme.id) continue
      if (byId.has(theme.id)) {
        logger.warn?.(`[theme] 插件主题 id 与已有主题冲突，已忽略：${theme.id}`)
        continue
      }
      byId.set(theme.id, theme)
    }
  }

  rebuild()

  /**
   * 拉取插件来源并重建目录。
   *
   * 走 `call`（异步）而不是 `callSync`：主题定义可能来自主题插件目录里的一个
   * `theme.json` 文件 —— 那是 IO，同步读盘在启动路径上是要避免的（见宪法关于
   * 同步盘 IO 的那条）。启动期由 `prime()` 预热一次，之后目录常驻内存，渲染层问列表时不再等 IO。
   */
  async function refreshSources(): Promise<ThemeData[]> {
    const collected: Array<Record<string, unknown>> = []

    // ── ② 声明式：manifest `contributes.themes`（纯数据、零代码）──────────────
    // 贡献注册表按 kind 收集，禁用插件时 `clearPlugin` 会一并摘掉 —— 于是
    // "禁用主题插件 = 主题立刻消失"是机制自然结果，不需要这里额外做清理。
    if (contributions && typeof contributions.list === 'function') {
      try {
        const list = contributions.list('themes')
        for (const item of Array.isArray(list) ? list : []) {
          if (item && typeof item === 'object') collected.push({ ...item, source: 'plugin' })
        }
      } catch (e) {
        logger.warn?.('[theme] contributes.themes 读取失败：', errorMessage(e))
      }
    }

    // ── ③ 计算式：`theme.source` 插槽（需要运行时才算得出的主题）─────────────
    // 走 `call`（异步）而不是 `callSync`：主题定义可能来自主题插件目录里的一个
    // `theme.json` 文件 —— 那是 IO，同步读盘在启动路径上是要避免的。
    // 启动期由 `prime()` 预热一次，插件启动完成后由组合根再刷一次。
    if (
      extensionPoints &&
      typeof extensionPoints.call === 'function' &&
      typeof extensionPoints.isDefined === 'function' &&
      extensionPoints.isDefined('theme.source')
    ) {
      try {
        const list = await extensionPoints.call('theme.source', {})
        for (const raw of Array.isArray(list) ? list.flat() : []) {
          if (raw && typeof raw === 'object') collected.push({ ...raw, source: raw.source || 'plugin' })
        }
      } catch (e) {
        logger.warn?.('[theme] theme.source 拉取失败（已回落内置主题）：', errorMessage(e))
      }
    }

    pluginThemes = collected
    catalogScopeKey = currentCatalogScopeKey()
    rebuild()
    emit('catalog', '')
    return list()
  }

  /** 主题列表（按 UI 展示顺序：内置在前，插件在后）。 */
  function list(): ThemeData[] {
    ensureCatalogForScope()
    return Array.from(byId.values())
  }

  function get(id: unknown): ThemeData | null {
    ensureCatalogForScope()
    return byId.get(String(id == null ? '' : id)) || null
  }

  // ══════════════════════════════════════════════════════════════════
  // 用户主题（编辑器保存的成果）：读写与增删
  // ══════════════════════════════════════════════════════════════════

  /**
   * 用户主题的原始数组（settings 里那份）。
   *
   * 刻意**不做归一化**：这里要的是"落盘的那份原始数据"，因为保存走的是
   * 「读出来 → 替换一项 → 写回去」——中间若被归一化，用户手写在 JSON 里的
   * 未知字段（将来的新槽位、作者的注释字段）会在第一次保存时被静默抹掉。
   * 归一化只发生在**进目录**（`rebuild`）与**返回给调用方**（`saveUserTheme`）时。
   */
  function readUserThemes(): Array<Record<string, unknown>> {
    if (!settings || typeof settings.get !== 'function') return []
    const raw = settings.get(THEME_SETTING_KEYS.userThemes)
    return Array.isArray(raw) ? raw : []
  }

  /** 用户主题（可编辑、可删除的那一类）。 */
  function listUserThemes(): ThemeData[] {
    return list().filter((t) => isUserThemeId(t.id))
  }

  /**
   * 保存（新建或覆盖）一条用户主题。
   *
   * 两条拒绝规则都落在 id 上，而不是"查一下目录来源"：
   *   · `id` 为空 → 新建，生成 `user.<base36 时间>`；
   *   · `id` 非 `user.` 前缀 → 拒绝（内置 / 插件主题不可被编辑器改写，
   *     否则"恢复出厂主题"会失效，且插件更新会悄悄改掉用户的配色）。
   *
   * @param {any} raw 主题定义（编辑器给的草稿）
   * @returns {Promise<{ ok: boolean, reason?: string, theme?: object }>}
   */
  async function saveUserTheme(raw: unknown) : Promise<{ ok: boolean, reason?: string, theme?: object }> {
    if (!settings || typeof settings.set !== 'function') return { ok: false, reason: '设置服务不可用' }
    const input: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const wanted = String(input.id == null ? '' : input.id)
    if (wanted && !isUserThemeId(wanted)) {
      return { ok: false, reason: '内置主题与插件主题不可编辑，请用「另存为副本」' }
    }
    const id = wanted || `${USER_THEME_ID_PREFIX}${Date.now().toString(36)}`
    const theme = normalizeTheme({
      ...input,
      id,
      source: 'user',
      name: input.name ? String(input.name) : '自定义主题'
    })
    const all = readUserThemes().filter((t) => String(t && t.id) !== id)
    all.push({ ...theme })
    await settings.set(THEME_SETTING_KEYS.userThemes, all)
    catalogScopeKey = currentCatalogScopeKey()
    rebuild()
    emit('catalog', id)
    return { ok: true, theme: get(id) || theme }
  }

  /**
   * 删除一条用户主题。
   *
   * 若删的正是当前主题，**顺手回落默认主题**（而不是让 `getActiveTheme` 每次现兜底）：
   * 兜底是"读的时候算"，不写回设置的话，设置页与别处的读取方会一直看到那个已经不存在的 id。
   */
  async function deleteUserTheme(id: unknown) {
    if (!settings || typeof settings.set !== 'function') return { ok: false, reason: '设置服务不可用' }
    const key = String(id == null ? '' : id)
    if (!isUserThemeId(key)) return { ok: false, reason: '只有自建主题可以删除' }
    const all = readUserThemes().filter((t) => String(t && t.id) !== key)
    await settings.set(THEME_SETTING_KEYS.userThemes, all)
    const wasActive = activeRef().id === key
    if (wasActive) await setActive(DEFAULT_THEME_ID, { reason: 'user' })
    catalogScopeKey = currentCatalogScopeKey()
    rebuild()
    emit('catalog', '')
    return { ok: true, wasActive, activeId: getActiveId() }
  }

  /**
   * 编辑器草稿：以某条主题为起点。
   * 传 `baseId` 就是「编辑它」的起点（内置/插件主题会被复制成用户主题草稿，
   * id 留空 —— 保存时生成新的），传空则是"从当前主题新建"。
   *
   * **不落盘**：草稿只是内存里的一份数据，编辑器实时预览它、点保存才成为资产。
   *
   * `opts.asNew`：**必须**派生一份 id 为空的新草稿（「新建主题」按钮）。
   * 为什么单独一档：不带它时，起点若是自建主题就按"原地编辑"返回**同一个 id、
   * 同一份内容** —— 界面上看不出任何变化，用户会认为按钮坏了。
   * @param {string} [baseId]
   * @param {{ asNew?: boolean }} [opts]
   */
  function draftTheme(baseId?: string, opts?: { asNew?: boolean }): ThemeData {
    const asNew = !!(opts && opts.asNew)
    const base = baseId ? get(baseId) : getActiveTheme()
    const src = base || getActiveTheme()
    // 是用户主题、且不是"新建" → 原地编辑（沿用同一个 id）；否则 → 派生 id 为空的新草稿
    return !asNew && isUserThemeId(src && src.id)
      ? normalizeTheme({ ...src, source: 'user' })
      : createUserTheme(src, { name: `${(src && src.name) || '主题'} 副本` })
  }

  // ══════════════════════════════════════════════════════════════════
  // 私密窗口主题
  // ══════════════════════════════════════════════════════════════════

  /** 私密窗口专用主题 id（空串 = 与普通窗口相同）。 */
  function privateThemeId(): string {
    if (!settings || typeof settings.get !== 'function') return ''
    const raw = settings.get(THEME_SETTING_KEYS.privateTheme)
    return raw == null ? '' : String(raw)
  }

  /**
   * **某个窗口**实际应当使用的主题（私密窗口可以有自己的皮肤）。
   *
   * 为什么这条判定在主进程而不是渲染层：私密与否是**窗口属性**，渲染进程只知道
   * 自己那一份视图；让每个渲染方自己去 settings 里读私密主题再判，会在三套消费面上
   * 各写一遍（外壳 / 内部页 / 新标签页），且与"谁是私密窗口"这个事实不同源。
   *
   * @param {{ incognito?: boolean }} [opts]
   */
  function getActiveThemeFor(opts: { incognito?: boolean } = {}): ThemeData | null {
    if (opts && opts.incognito) {
      const id = privateThemeId()
      const theme = id ? get(id) : null
      // 私密主题被删掉 / id 失效时**回落普通主题**，而不是回落内置 ——
      // 用户至少还能看到一个正常的皮肤，而不是"A 窗口和 B 窗口长得不一样"。
      if (theme) return theme
    }
    return getActiveTheme()
  }

  /**
   * 设置里的当前值 → 主题 id（兼容旧三态 light/dark/system）。
   * @returns {{ id: string, wasLegacy: boolean, wantsSystemSchedule: boolean }}
   */
  function activeRef() : { id: string, wasLegacy: boolean, wantsSystemSchedule: boolean } {
    const raw = settings ? settings.get(THEME_SETTING_KEYS.active) : null
    return legacyActiveTheme(raw)
  }

  /** 当前主题对象；id 失效（主题被卸载 / 配置被手改）时回落默认主题。 */
  function getActiveTheme(): ThemeData | null {
    const ref = activeRef()
    return byId.get(ref.id) || get(DEFAULT_THEME_ID) || list()[0] || null
  }

  /** 当前主题 id（已是归一化后的 id，不是旧三态值）。 */
  function getActiveId(): string {
    const theme = getActiveTheme()
    return theme ? theme.id : DEFAULT_THEME_ID
  }

  /**
   * 切主题。写的是 `app.theme`（主题 id）—— 于是"改主题"与"读主题"共用同一处持久化，
   * 无需为它单独开一张表。
   *
   * @param {string} id
   * @param {{ reason?: 'user' | 'schedule' }} [opts]
   *   `reason==='user'`（默认）时会**顺手把调度切回 `none`** —— 用户的显式选择必须
   *   压过任何自动切换，否则"我选了浅色，十分钟后它自己变回去了"。
   *   调度器自己调用时必须传 `'schedule'`，不然它每切一次就把自己的调度关掉（自我打死）。
   */
  async function setActive(id: unknown, opts: { reason?: string } = {}) {
    const next = String(id == null ? '' : id)
    const theme = get(next)
    if (!theme) return { ok: false, reason: '主题不存在' }
    const reason = opts.reason === 'schedule' ? 'schedule' : 'user'
    if (getActiveId() === next) return { ok: true, theme, changed: false }
    if (settings && typeof settings.set === 'function') {
      if (reason === 'user') {
        const schedule = normalizeThemeSchedule(settings.get(THEME_SETTING_KEYS.schedule))
        if (schedule.mode !== 'none') {
          await settings.set(THEME_SETTING_KEYS.schedule, { ...schedule, mode: 'none' })
        }
      }
      await settings.set(THEME_SETTING_KEYS.active, next)
    }
    emit('active', next)
    return { ok: true, theme, changed: true }
  }

  /**
   * 一次性迁移：旧三态值落成主题 id；`system` 额外把调度设成"跟随系统"。
   *
   * 为什么 `system` 要落成 `hira-light` + 调度：主题系统里"跟随系统"不是一种主题，
   * 而是**调度**的一档（对齐 Vivaldi）—— 于是它表达的是"白天用这个、夜间用那个"，
   * 比"一个会自己变色的主题"更能装下用户的真实意图。
   *
   * @returns {Promise<boolean>} 是否发生了迁移
   */
  async function migrateLegacy(): Promise<boolean> {
    if (!settings || typeof settings.set !== 'function') return false
    const ref = activeRef()
    if (!ref.wasLegacy) return false
    await settings.set(THEME_SETTING_KEYS.active, ref.id)
    if (ref.wantsSystemSchedule) {
      const current = normalizeThemeSchedule(settings.get(THEME_SETTING_KEYS.schedule))
      if (current.mode === 'none') {
        await settings.set(THEME_SETTING_KEYS.schedule, { ...current, mode: 'system' })
      }
    }
    logger.info && logger.info(`[theme] 旧主题设置已迁移：${ref.id}`)
    return true
  }

  /**
   * 应用 `theme.decorator` 流水线（社区 Mod 整体改写配色）。
   * 失败一律回落原主题 —— 一个坏 Mod 不该让整个界面没有颜色。
   */
  async function decorate(theme: ThemeData | null): Promise<ThemeData | null> {
    const raw = theme || getActiveTheme()
    if (!raw) return null
    if (
      !extensionPoints ||
      typeof extensionPoints.call !== 'function' ||
      typeof extensionPoints.isDefined !== 'function' ||
      !extensionPoints.isDefined('theme.decorator')
    ) {
      return raw
    }
    try {
      const out = await extensionPoints.call('theme.decorator', raw)
      return out ? normalizeTheme(out) : raw
    } catch (e) {
      logger.warn?.('[theme] theme.decorator 执行失败（已用原主题）：', errorMessage(e))
      return raw
    }
  }

  /** 主题 → 令牌表（唯一真源在 shared-types）。 */
  function tokensFor(theme: ThemeData): Record<string, string> {
    const t = theme || getActiveTheme()
    /* 壁纸亮度只被「自动前景」那一档用到（colors.*Fg === 'auto'）；
       拿不到时自动档在 theme.mjs 里退回"按主题底色判"，所以这里传 null 也是确定的。 */
    return themeToTokens(t, { wallpaperLuminance: wallpaperLuminanceFor(t) })
  }

  /** 主题 → 令牌 CSS（给 insertCSS 用；渲染层优先走 setProperty，不需要这段文本）。 */
  function cssFor(theme: ThemeData): string {
    return themeTokensToCss(tokensFor(theme))
  }

  /**
   * 主题背景资产的 URL（图片**或视频**）—— **两条通道，按来源选**：
   *
   *   · **插件主题**（`theme.pluginId` 有值）：文件住在插件目录里，走
   *     `hira-plugin://<pluginId>/background.jpg`（只有启用中的插件读得到）；
   *   · **用户主题**（编辑器"选择图片 / 视频"选的）：文件住在 app 的**主题资产库**里，走
   *     `hira-theme://asset/<内容哈希>-<原名>.jpg`（见 theme-assets.js）。
   *
   * 之前这里对非插件来源直接返回空串 —— 于是"用户自建主题填了图片路径"是个**死值**：
   * 编辑器里有那一栏，填了却永远不生效。分开两条通道之后，图片背景对用户主题才真的成立。
   *
   * 返回空串的两种情形：不是"本地资产型"背景（纯色 / 渐变 / 每日图 / 桌面壁纸），
   * 或两条通道都没注入 —— 图片会由 `themeBackgroundCss` 回落成纯色，
   * 视频会由 `themeBackgroundStyle` 的 `mode:'video'` + 空 `videoSrc` 回落成"什么也不画"
   * （见 shared-types/src/theme-background.mjs#applyThemeBackground）。
   */
  function assetUrlFor(theme: ThemeData, relPath: unknown): string {
    if (!theme || !relPath) return ''
    const port = theme.pluginId ? pluginAssets : userAssets
    if (!port || typeof port.url !== 'function') return ''
    try {
      const rel = String(relPath)
      const url = theme.pluginId
        ? pluginAssets && typeof pluginAssets.url === 'function' ? pluginAssets.url(theme.pluginId, rel) : ''
        : userAssets && typeof userAssets.url === 'function' ? userAssets.url(rel) : ''
      return url || ''
    } catch (e) {
      logger.warn?.('[theme] 资产 URL 生成失败：', errorMessage(e))
      return ''
    }
  }

  /**
   * 「每日一图」今天那张图的地址（同步读缓存）。
   *
   * 拿不到就顺手起一次后台拉取（幂等 + 并发去重，见 theme-daily.js），
   * **拉到之后再发一次 `background` 主题事件** —— 那时界面才有图可换。
   * 所以这里的失败是静默的：没有图就露出主题自己的底色，不报错、不阻塞任何渲染。
   */
  function dailyUrl(): string {
    if (!dailyBackground || typeof dailyBackground.get !== 'function') return ''
    const url = dailyBackground.get()
    if (url) return url
    if (typeof dailyBackground.ensure === 'function') {
      Promise.resolve(dailyBackground.ensure())
        .then((got) => { if (got) emit('background', '') })
        .catch(() => {})
    }
    return ''
  }

  /**
   * 这份主题的背景**从哪来**（= 身份 + 怎么读它）。不是"本地资产型"背景时返回 null。
   *
   * 为什么要一个"来源描述"而不是直接读：亮度测量是**异步**的，而它的结果要按
   * **图片身份**缓存 —— 身份必须包含"用户资产 / 插件资产 / 每日一图"的来源差别，
   * 否则两张同名的背景图会互相污染缓存。读法（字节从哪来）也一并带上，
   * 于是 theme-luminance.js 只需要一个 `loader()` 回调，不认识资产库与网络。
   *
   * 「每日一图」的身份里带**当天的 URL** —— 跨天换图 ⇒ 身份变了 ⇒ 自然重新量。
   *
   * 覆盖的种类取自共享层的 `BACKGROUND_ASSET_KINDS`（图片 / 视频同一份清单）——
   * 视频也要走这里，因为**导出主题包**与**本地预览**都要读它的字节。
   */
  function backgroundSource(theme: ThemeData | null): ThemeBackgroundSource | null {
    const t = theme || getActiveTheme()
    const bg = t && t.background
    if (!bg) return null
    if (bg.kind === 'daily') {
      const url = dailyUrl()
      return url ? { id: `daily:${url}`, kind: 'remote', url } : null
    }
    if (!BACKGROUND_ASSET_KINDS.includes(bg.kind) || !bg.path) return null
    return t.pluginId
      ? { id: `plugin:${t.pluginId}:${bg.path}`, kind: 'plugin', pluginId: t.pluginId, path: bg.path }
      : { id: `user:${bg.path}`, kind: 'user', path: bg.path }
  }

  /** 按来源描述取图片字节（失败一律 null；两条资产通道都走各自的 `read` 口）。 */
  async function readBackgroundBytes(src: ThemeBackgroundSource): Promise<Buffer | null> {
    if (!src) return null
    try {
      if (src.kind === 'remote') {
        return typeof dailyBackground?.bytes === 'function' ? await dailyBackground.bytes(src.url) : null
      }
      const port = src.kind === 'plugin' ? pluginAssets : userAssets
      if (!port || typeof port.read !== 'function') return null
      return src.kind === 'plugin' ? await port.read(src.pluginId, src.path) : await port.read(src.path)
    } catch (e) {
      logger.warn?.('[theme] 读背景图字节失败（自动前景退回按底色判）：', errorMessage(e))
      return null
    }
  }

  /**
   * 这份主题壁纸的**平均亮度**（0~1；不是"可测"的背景 / 还没量到 → null）。
   *
   * 同步读缓存 —— 因为 `backgroundFor` / `tokensFor` 必须同步（渲染侧等不了异步）。
   * 没量过就顺手起一次后台测量，量**成功**后发一次 `background` 主题事件 ——
   * 与「每日一图」图到了再重发一次是**同一条路**（见 dailyUrl），
   * 于是"自动前景"会在图到位后的下一拍自动跟上，不需要任何额外机制。
   *
   * ⚠ **视频刻意不测**：`autoFgFor` 要的是"这一层有多亮"**一个数**，而动态画面
   * 没有单一亮度（首帧亮、中段可能全黑）。取首帧会给出错误的安全感，比不给更糟。
   * 所以视频背景时自动档退回"按主题底色判"，编辑器也会明确提示作者手选前景色
   * （见 docs-ng/主题系统设计.md §6.4.3）。这里直接返回 null，连字节都不去读。
   */
  function wallpaperLuminanceFor(theme: ThemeData | null): number | null {
    const t = theme || getActiveTheme()
    if (t && t.background && t.background.kind === 'video') return null
    const src = backgroundSource(t)
    if (!src) return null
    const cached = wallpaperLuminance.peek(src.id)
    if (cached != null) return cached
    wallpaperLuminance.ensure(src.id, () => readBackgroundBytes(src), () => emit('background', ''))
    return null
  }

  /**
   * 主题 → **可直接落地的背景描述**（按窗口 / 新标签页两个面各算一份）。
   *
   * 为什么由主进程算好再推：内部页（`hira://`）是**未经打包的普通 ESM**，
   * 它们 import 不了 `@hira-ng/shared-types`（那是构建期才有的裸包名）。
   * 所以"背景怎么画"这件事不能在渲染侧各写一份 —— 主进程算完直接给结果，
   * 渲染侧只做 `style.backgroundImage = s.backgroundImage` 这种纯赋值。
   */
  function backgroundFor(theme: ThemeData | null): Record<string, unknown> | null {
    const t = theme || getActiveTheme()
    if (!t) return null
    const bg = t.background
    const bundle = {
      kind: bg.kind,
      applyTo: bg.applyTo,
      // daily 才去问取图器：其他背景问它等于凭空触发一次联网。
      ...themeBackgroundCss(bg, assetUrlFor(t, bg.path), bg.kind === 'daily' ? dailyUrl() : ''),
      /**
       * 视频背景的地址（`hira-theme://` / `hira-plugin://`）。
       *
       * 为什么与 `backgroundImage` 分成两个字段而不是塞进一个：`<video>` 的 `src`
       * 与 CSS 的 `background-image` 是**两种消费方式**，渲染侧要按 `mode` 二选一
       * （见 shared-types/src/theme-background.mjs）。把它塞进 `backgroundImage`
       * （比如 `url(...)` 字符串）会逼渲染侧去解析 CSS —— 那是第二处判据。
       * 非视频背景一律空串，于是"图片主题的这条链"逐字不变。
       */
      videoSrc: bg.kind === 'video' ? assetUrlFor(t, bg.path) : ''
    }
    return {
      kind: bg.kind,
      applyTo: bg.applyTo,
      /**
       * 这张壁纸的**平均亮度**（0~1；测不到为 null）。
       * 「自动前景」（`colors.*Fg === 'auto'`）就是按它判黑/白的 —— 渲染侧
       * （主题编辑器的"自动"行）也读这个数，于是"显示的自动色 = 真会生效的色"。
       */
      luminance: wallpaperLuminanceFor(t),
      window: themeBackgroundStyle(bundle, 'window'),
      newtab: themeBackgroundStyle(bundle, 'newtab')
    }
  }

  return {
    /** 启动期预热：拉插件来源 + 跑旧值迁移。**必须在建窗之前 await 一次。** */
    async prime() {
      await migrateLegacy()
      await refreshSources()
      return list()
    },
    list,
    get,
    getActiveId,
    getActiveTheme,
    /** 某个窗口实际用的主题（私密窗口可另有皮肤）。 */
    getActiveThemeFor,
    setActive,
    // ── 用户主题（编辑器）──
    listUserThemes,
    saveUserTheme,
    deleteUserTheme,
    draftTheme,
    // ── 私密窗口 ──
    privateThemeId,
    decorate,
    tokensFor,
    cssFor,
    backgroundFor,
    isDark: (theme?: ThemeData | null) => isDarkTheme(theme || getActiveTheme()),
    refreshSources,
    migrateLegacy,
    /**
     * 晚绑定声明式贡献注册表（`contributes.themes` 的来源）。
     * 组合根在注册表建好后调用一次；调用方随后应 `refreshSources()` 以纳入新主题。
     */
    setContributions(registry: ThemeContributionsPort | null | undefined) {
      contributions = registry || null
    },
    /** @returns {() => void} 退订函数 */
    subscribe(fn: (change: ThemeChange) => void) : () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}


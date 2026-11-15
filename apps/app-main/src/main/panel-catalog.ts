/**
 * 面板目录（Panel Catalog）—— 侧栏面板的**运行时单一事实源**。
 *
 * 它替代了过去散在三处的编译期常量：
 *   · `infra-window#PANEL_IDS`（主进程的面板白名单）
 *   · `ui-common#PANEL_CATALOG` 里的 10 个面板条目（渲染层的图标/标签）
 *   · `renderer/panels/main.js` 的 9 个静态 import + PANEL_SETUP 硬编码 switch
 *
 * 现在的链路是单向的、且只有一个上游：
 *   插件 manifest 的 `contributes.panels`
 *        → PluginRegistryV2 在 enable 时灌进 ContributionRegistry
 *        → 本目录（过滤 + 排序 + 归一化）
 *        → IPC `panel:catalog` / `panel:list`
 *        → rail / navbar / 按钮编辑浮层 / panels renderer **全部由同一份目录渲染**
 *
 * 于是「装一个面板插件 = 多一个面板」，「禁用一个面板插件 = 面板连同按钮一起消失」，
 * 不再需要改任何核心代码 —— 这就是 UI 动态装配的数据侧。
 *
 * 图标为什么是**字符串**而不是函数：目录要过 IPC（结构化克隆），函数不能序列化。
 * 渲染层拿名字到 `ui-common#ICON_REGISTRY` 里查构造函数，函数因此只活在渲染侧。
 *
 * **形状（`PanelEntry`）与回落规则不在这里** —— 唯一真源是
 * `packages/shared-types/src/panel-entry.mjs#normalizePanelEntry`（纯层，渲染层读同一份）。
 * 本目录只负责三件事：**合并来源 / 排序 / 取单条**。
 * 字段名与 `infra-ipc/src/contracts/layout.js#panelEntrySchema` 必须逐字一致。
 */

const { normalizePanelEntries, normalizePanelEntry } = require('@hira-ng/shared-types/src/panel-entry.mjs')

/** 扩展点种类名（与 manifest `contributes.panels` 的 key 一致）。 */
const PANELS_KIND = 'panels'

interface PanelEntry {
  id: string
  title?: string
  icon?: string
  order?: number
  segment?: string
  pluginId?: string
  opensWindow?: string
  opensPage?: string
  hostPage?: string
  bangs?: string[]
  presentation?: string
  [key: string]: unknown
}

interface PanelOverride {
  id?: string
  panelId?: string
  remove?: boolean
  patch?: Record<string, unknown>
  order?: number
}

interface PanelCatalogOptions {
  contributions?: { list: (kind: string) => PanelEntry[] } | null
  fallback?: PanelEntry[]
  overrides?: () => PanelOverride[]
}

/**
 * 面板在 navbar / rail 的归属段（与 ui-common 的段划分对齐）。
 */
const PANEL_SEGMENT = 'panel'

/**
 * 保底面板集 —— **只在「插件系统完全不可用」时启用**。
 *
 * 触发场景：`plugins/` 目录缺失（打包漏带）、discover 抛错。此时若目录为空，
 * 用户会看到一个没有任何侧栏面板的浏览器 —— 比"面板不是插件"糟糕得多。
 * 注意它**不是**事实源：一旦插件系统就绪（哪怕用户把所有面板插件都禁用了），
 * 一律以贡献注册表为准，保底集立即让位（见 `list()` 的 ready 判定）。
 *
 * ⚠ 这些条目必须与各插件 manifest 的 `contributes.panels` **保持同形**（含
 * `opensWindow` / `opensPage`）—— 否则降级态与正常态会出现"同一个图标点了去不同地方"。
 */
const FALLBACK_PANELS: PanelEntry[] = [
  {
    id: 'favorites-panel', title: '书签', icon: 'Star', order: 100, segment: PANEL_SEGMENT,
  },
  // 集锦 / 稍后读 / 回收站是**独立面板**（与收藏分开：书签是导航，集锦是素材）。
  {
    id: 'notes-panel', title: '集锦', icon: 'StickyNote', order: 105, segment: PANEL_SEGMENT,
  },
  {
    id: 'history-panel', title: '最近历史', icon: 'Clock', order: 110, segment: PANEL_SEGMENT,
  },
  {
    id: 'downloads-panel', title: '活动下载', icon: 'Download', order: 120, segment: PANEL_SEGMENT,
  },
  {
    id: 'extensions-panel', title: '扩展', icon: 'Puzzle', order: 130, segment: PANEL_SEGMENT,
  },
  // 插件中心的入口**直达内部页 hira://plugins**（不再是侧栏面板，也不再开子窗口）
  {
    id: 'plugins-panel', title: '插件', icon: 'Blocks', order: 140, segment: PANEL_SEGMENT, opensPage: 'plugins',
  },
  // 主题：侧栏窄面板（当前主题 + 色卡网格 + 「管理主题…」入口）
  {
    id: 'themes-panel', title: '主题', icon: 'Palette', order: 145, segment: PANEL_SEGMENT,
  },
  // 画板（D4 Easel）：无限画布，面板只管导航，画布在独立窗口里（与 manifest 同形）。
  {
    id: 'easel-panel', title: '画板', icon: 'Shapes', order: 148, segment: PANEL_SEGMENT,
  },
  // 实时更新（J6 Live Folders：订阅源条目常驻侧栏，复用 NTP 新闻源；与 manifest 同形）。
  {
    id: 'live-folders-panel', title: '实时更新', icon: 'Rss', order: 156, segment: PANEL_SEGMENT,
  },
  // 注入规则（J10：Boosts / 强制深色 / 用户脚本的管理界面，与 manifest 同形）。
  {
    id: 'inject-panel', title: '注入', icon: 'Paintbrush', order: 165, segment: PANEL_SEGMENT,
  },
  {
    id: 'spaces-panel', title: '空间', icon: 'Layers', order: 170, segment: PANEL_SEGMENT,
  },
  // 会话（命名会话 + 自动快照；原「会话管理」子窗口已并入侧栏，与 manifest 同形）。
  {
    id: 'sessions-panel', title: '快速会话', icon: 'Folder', order: 176, segment: PANEL_SEGMENT,
  },
  // 固定标签 / 播放中并入「标签」面板；标签归档统一在集锦面板的「归档」分段。
  {
    id: 'open-tabs-panel', title: '标签', icon: 'AppWindow', order: 180, segment: PANEL_SEGMENT,
  },
  {
    id: 'permissions-panel', title: '权限', icon: 'Shield', order: 190, segment: PANEL_SEGMENT,
  },
  // 验证器（2FA）—— 与 manifest 的 contributes.panels 同形。
  // 注意它在本表里**没有**「是否启用」的信息：真实启用状态由插件系统管，
  // 保底目录只在"插件系统完全不可用"时接管，那时它只是一个可点的入口。
  {
    id: 'totp-panel', title: '验证器', icon: 'ShieldCheck', order: 200, segment: PANEL_SEGMENT,
  },
  // 扫码器 —— 与 manifest 的 contributes.panels 同形（同上）。
  {
    id: 'qr-scanner-panel', title: '扫码器', icon: 'ScanLine', order: 210, segment: PANEL_SEGMENT,
  }
]

/**
 * 面板改写可触及的字段白名单（= PanelEntry 的字段集，防止形状漂移）。
 *
 * 放在模块级并对外导出：`plugin-surfaces.js` 归一化 `panelOverrides` 时要按同一份
 * 白名单挑字段 —— 只允许存在**一个**真源，否则 manifest 与运行时两条入口会漂移。
 */
const PATCHABLE_FIELDS = Object.freeze([
  'title', 'icon', 'order', 'segment', 'pluginId',
  'opensWindow', 'opensPage', 'hostPage', 'bangs', 'presentation'
])

/**
 * @param {{
 *   contributions?: { list: (kind: string) => any[] },
 *   fallback?: any[],
 *   overrides?: () => Array<{ id?: string, panelId?: string, remove?: boolean, patch?: object, order?: number }>
 * }} [options]
 */
function createPanelCatalog(options: PanelCatalogOptions = {}) {
  const contributions = options.contributions || null
  const fallback = options.fallback || FALLBACK_PANELS
  /**
   * 面板改写 / 删除的**唯一入口**（插件 `contributes.panelOverrides`）。
   *
   * 为什么用回调而不是直接收一个数组：面板目录是长生命周期对象，贡献表却会随
   * 插件启停变化 —— 每次 `list()` 现取，才能做到"禁用插件 → 下一帧改写就消失"。
   *
   * 只允许改 `PanelEntry` 已有的字段（见 shared-types#panel-entry.mjs），
   * 绝不在这里引入第二套形状：`patch` 里出现未知键一律忽略。
   */
  const overrides = typeof options.overrides === 'function' ? options.overrides : null
  /**
   * 插件系统是否已就绪（enableAppPlugins 完成后置真）。
   * 未就绪 → 用保底集；就绪 → 一律以贡献为准（即使为空，那也是用户的真实选择）。
   */
  let pluginSystemReady = false

  /**
   * 逐条应用 `panelOverrides`。语义（与渲染侧 / 插件作者文档一致）：
   *   · `remove: true` → 把该面板从目录里摘掉（**做减法**）
   *   · `patch`        → 只覆盖给出的字段（**改现有面板**）
   * 顺序按 `order` 升序，后者覆盖前者；已被删除的 id 后续 patch 不再生效。
   */
  function applyOverrides(entries: PanelEntry[]): PanelEntry[] {
    if (!overrides) return entries
    let list
    try {
      list = overrides()
    } catch (_) {
      return entries
    }
    if (!Array.isArray(list) || list.length === 0) return entries
    const byId = new Map<string, PanelEntry>(entries.map((entry) => [entry.id, entry]))
    const removed = new Set<string>()
    const ordered = [...list].sort((a: PanelOverride, b: PanelOverride) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0))
    for (const item of ordered) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.panelId || item.id || '').trim()
      if (!id || !byId.has(id) || removed.has(id)) continue
      if (item.remove === true) {
        removed.add(id)
        byId.delete(id)
        continue
      }
      const patch = item.patch && typeof item.patch === 'object' ? item.patch : null
      if (!patch) continue
      const next: PanelEntry = { ...(byId.get(id) as PanelEntry) }
      let touched = false
      for (const key of PATCHABLE_FIELDS as Array<keyof PanelEntry>) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
        next[key] = patch[key] === null ? undefined : patch[key]
        touched = true
      }
      if (touched) byId.set(id, normalizePanelEntry(next) as PanelEntry)
    }
    return Array.from(byId.values())
  }

  /** 面板目录（按 order 升序）：插件贡献（或保底集）→ 应用插件改写。 */
  function list(): PanelEntry[] {
    const contributed = contributions ? contributions.list(PANELS_KIND) : []
    const useFallback = !pluginSystemReady && contributed.length === 0
    const source = useFallback ? fallback : contributed
    // 归一化（含"丢掉没有 id 的废条目"）走纯层唯一实现；排序是目录自己的口径，留在这里。
    return applyOverrides(normalizePanelEntries(source) as PanelEntry[]).sort((a: PanelEntry, b: PanelEntry) => (Number(a.order) || 0) - (Number(b.order) || 0))
  }

  return {
    /** 插件系统就绪标记（由 main.js 在 enableAppPlugins 之后调用）。 */
    markReady() {
      pluginSystemReady = true
    },
    isReady() {
      return pluginSystemReady
    },
    list,
    /** 面板 id 列表（`panel:list` 的载荷；rail/navbar 的渲染入口）。 */
    ids() {
      return list().map((p: PanelEntry) => p.id)
    },
    has(panelId: string): boolean {
      const id = String(panelId || '')
      return list().some((p: PanelEntry) => p.id === id)
    },
    /**
     * 取**单条**（面板视图工厂要"这个 id 该怎么加载"）。找不到返回 null。
     * 与 `has()` 同源（都走 `list()`），因此"目录里有它"与"拿得到它"不可能不一致。
     */
    entry(panelId: string): PanelEntry | null {
      const id = String(panelId == null ? '' : panelId)
      return list().find((p: PanelEntry) => p.id === id) || null
    }
  }
}

module.exports = { createPanelCatalog, PANELS_KIND, FALLBACK_PANELS, PATCHABLE_PANEL_FIELDS: PATCHABLE_FIELDS }

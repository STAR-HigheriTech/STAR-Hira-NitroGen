/**
 * panel-views.js —— 面板**视图工厂**（apps 层）。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────
 * 把"面板"这件事收成一个窄接口交给布局层与 IPC 层：造视图 / 加载 / 销毁。
 * 面板**只有一种**：我们自己的本地渲染页（`out/renderer/panels/?panelId=`）。
 *
 * ── 这次重写它丢了什么（不是被简化，是被**移走**）──────────────────────
 * 曾经这里塞着"面板也可以是远程网页"的一整套适配：`specFor` 的 web 分支、
 * UA 覆盖（移动 / 桌面视图）、`panel-web-header` 顶条、`viewModeOverride` 覆盖表、
 * `command` / `ownsWebContents` / `pushHeaderState` / `refreshHeader`。
 * 那是把**两个不同的板块**（面板 / 侧栏浏览）焊在一起，后果是两边都做不好 ——
 * 侧栏拿不到完整的网页能力，面板目录里还混进了一种"不是面板的东西"。
 *
 * 现在：远程网页侧栏是一个**独立子系统**（`apps/main/web-sidebar.js` +
 * `LayoutCoordinator` 的独立区域 + 自己的存储），与这里**零交集**。
 * 于是本文件回到它唯一该做的事：给一个 panelId，给一个本地页视图。
 */

/**
 * @param {{
 *   wcm: object,                                   // WebContentsManager（视图工厂）
 *   getCatalog?: () => object|null,                // 面板目录（只需 `entry(id)`）—— **延迟解析**
 * }} deps
 */
export interface PanelCatalogLike {
  entry: (panelId: string) => PanelEntryLike | null
}

export interface PanelEntryLike {
  id: string
  title?: string
  pluginId?: string
  icon?: string
}

export interface PanelViewDeps {
  wcm: {
    createPanel: (panelId: string) => Electron.WebContentsView | null
    loadPanel: (panelId: string, hints: Record<string,string>) => Promise<unknown>
    destroyPanel: (panelId: string) => boolean
    reloadPanel: (panelId: string) => boolean
  }
  getCatalog?: () => PanelCatalogLike | null
  catalog?: PanelCatalogLike | null
}

export interface PanelViewParts {
  content: Electron.WebContentsView
  header: null
  headerHeight: number
}

export function createPanelViewFactory(deps: PanelViewDeps): {
  ensure(panelId: string): PanelViewParts | null
  has(panelId: string): boolean
  destroy(panelId: string): boolean
  reload(panelId: string): boolean
} {
  const wcm = deps.wcm
  /**
   * ⚠ 目录必须**用时再取**（`getCatalog()`），不能在这里快照。
   *
   * 踩过的坑：主窗口在 `main.js:587` 就打开，而面板目录到 `main.js:2118` 才建出来 ——
   * 开窗那一刻 `shared.panelCatalog` 还是 undefined，快照下来就是"这个窗口永远没有目录"，
   * 于是 `ensure()` 恒返回 null，**所有面板全打不开**（现象是"点 panel 没反应、不显示"）。
   * 延迟取用即根治。
   */
  const getCatalog = typeof deps.getCatalog === 'function'
    ? deps.getCatalog
    : () => deps.catalog || null

  /** 目录现取（面板集合随插件启停变化，绝不能缓存快照；目录实例本身也可能晚于窗口创建）。 */
  function entryOf(panelId: string): PanelEntryLike | null {
    const id = String(panelId == null ? '' : panelId)
    if (!id) return null
    const catalog = getCatalog()
    if (!catalog || typeof catalog.entry !== 'function') return null
    try { return catalog.entry(id) } catch (_) { return null }
  }

  return {
    /**
     * 造 + 加载这个面板的视图（**幂等**：WCM 自己按 id 去重）。
     *
     * @returns {{ content: Electron.WebContentsView|null, header: null, headerHeight: number }|null}
     *   本层恒返回 `header: null / headerHeight: 0` —— 面板自己会在本地页里画 header
     *   （`ui-common#createPanelShell`），不需要布局层让位。
     *   返回 null = 目录里没有这条（调用方据此**不要**去占位，否则会出现"空面板 + 白占宽度"）。
     */
    ensure(panelId: string): PanelViewParts | null {
      const id = String(panelId == null ? '' : panelId)
      /**
       * 目录查不到这条时的**退路**（不是常态，但必须留）：目录晚于窗口就绪（历史事故）
       * 或 id 已失效（插件刚被禁用，IPC 层已先拦）。退路 = 照样把本地页造出来 ——
       * 静默失灵（"点了没反应"）比告警糟糕得多。
       */
      const entry = entryOf(id)
      const effective = entry || { id }
      const content = wcm.createPanel(effective.id)
      if (!content) return null
      /**
       * 把「这一条叫什么 / 属于哪个插件」随页面加载一起送过去。
       *
       * 面板页是**关闭即销毁、每次重开都冷启动**的：标题若还要它自己发一次
       * `panel:catalog` IPC 去问，这一次往返就直接落在「第一帧」的关键路径上。
       * 目录就在本进程里（`entry` 已经在手），顺手写进 query —— 渲染侧模块求值即可读到，
       * 画壳与目录往返彻底解耦。空值不传（保持 URL 干净）。
       */
      const hints: Record<string, string> = {}
      if (entry && entry.title) hints.title = String(entry.title)
      if (entry && entry.pluginId) hints.pluginId = String(entry.pluginId)
      // 面板图标（目录里的图标名）：标题栏第一帧就能带上图标，不必再问一次目录。
      // 插件可能写 data URL / 原始 SVG（见 ui-common#resolveIcon）—— 过长就不塞进
      // query（一个图标不该让 URL 膨胀到几 KB），标题栏少一颗图标不影响可用性。
      if (entry && entry.icon && String(entry.icon).length <= 512) hints.icon = String(entry.icon)
      Promise.resolve(wcm.loadPanel(effective.id, hints)).catch((e) => {
        console.error('[panel-views] load failed:', e instanceof Error ? e.message : e)
      })
      return { content, header: null, headerHeight: 0 }
    },

    /** 目录里有没有这条（IPC / 装配的校验口，避免去打开一个不存在的面板）。 */
    has(panelId: string): boolean {
      return !!entryOf(panelId)
    },

    /** 销毁这个面板的视图：谁造的谁销毁，布局层只负责摘图层。 */
    destroy(panelId: string): boolean {
      const id = String(panelId == null ? '' : panelId)
      try { return !!wcm.destroyPanel(id) } catch (_) { return false }
    },

    reload(panelId: string): boolean {
      const id = String(panelId == null ? '' : panelId)
      try { return !!wcm.reloadPanel(id) } catch (_) { return false }
    }
  }
}

module.exports = { createPanelViewFactory }

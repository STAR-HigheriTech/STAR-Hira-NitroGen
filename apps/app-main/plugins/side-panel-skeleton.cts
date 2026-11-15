/**
 * side-panel-skeleton —— 侧栏骨架（所有面板插件的**前置依赖**，CONTRACT-07）。
 *
 * 职责边界（对齐 RT）：只提供「面板载体」这一件事 ——
 *   · 面板视图的**惰性**创建（绝不预热：启动期拉起 9 个面板渲染进程是「跟 IE 一样卡」的主因之一）
 *   · 显隐切换（委托 LayoutCoordinator）
 *
 * 面板清单从哪来：**由 ctx.panelCatalog 注入**（APPS 的面板目录，源自各面板插件的
 * manifest `contributes.panels`）。骨架自身不认识任何具体面板 —— 装一个面板插件，
 * 目录里就多一项；禁用，就少一项。这正是「面板可拆装」的关键：
 * 骨架是机制，面板清单是别人贡献的数据。
 */
interface SidePanelContext {
  webContentsManager?: {
    createPanel(panelId: string): { webContents: unknown }
  }
  layoutCoordinator?: {
    togglePanel(panelId: string, opts: { side?: 'left' | 'right' }): unknown
  }
  themeManager?: {
    isApplied(webContents: unknown): boolean
    applyToWebContents(webContents: unknown): Promise<unknown>
  }
  panelCatalog?: {
    ids(): string[]
  }
}

module.exports = {
  install(ctx: SidePanelContext) {
    const { webContentsManager } = ctx
    if (!webContentsManager) throw new Error('webContentsManager is required')
  },

  registerExtensionPoints(ctx: SidePanelContext) {
    const { webContentsManager, layoutCoordinator, themeManager, panelCatalog } = ctx
    if (!webContentsManager) throw new Error('webContentsManager is required')
    if (!layoutCoordinator) throw new Error('layoutCoordinator is required')
    const service = {
      /** 当前面板 id 列表（目录快照；调用方不应缓存 —— 插件启停会改变集合）。 */
      panelIds() {
        return panelCatalog ? panelCatalog.ids() : []
      },
      /** 取（必要时创建）某面板的 webContents，供需要直接操作视图的调用方使用。 */
      getPanelWebContents(panelId: string) {
        const view = webContentsManager.createPanel(String(panelId))
        if (themeManager && !themeManager.isApplied(view.webContents)) {
          themeManager.applyToWebContents(view.webContents).catch(() => {})
        }
        return view.webContents
      },
      /**
       * 开关面板。
       * @param {string} panelId
       * @param {{ side?: 'left'|'right' }} [opts] 放在哪一侧；缺省 = 设置那一侧
       *   （navbar 的面板按钮传 'right'，见 layout 契约的 panelToggle.request.side）
       */
      toggle(panelId: string, opts?: { side?: 'left'|'right' }) {
        return layoutCoordinator.togglePanel(panelId, opts || {})
      }
    }

    return [{ name: 'sidepanel.service', service }]
  },

  // 对齐 RT：**不预热面板**。面板视图/内容在首次真正显示时惰性创建
  // （LayoutCoordinator.showPanel → WebContentsManager.loadPanel）。
  // 旧实现在此处 warmupPanels() 一次性拉起 9 个面板渲染进程 —— 已删除。
  enable() {},

  disable() {},

  uninstall() {}
}

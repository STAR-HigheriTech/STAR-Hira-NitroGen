import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/layout.js — 布局相关生效器
 *
 * 纵向轨道上**两段各自独立**的位置键，各由一个生效器负责（互不牵连）：
 * 1. `app.sidebar_position` + 两条起始边 —— 工具图标栏（rail）+ 侧边面板那一段；
 *    位置可取左 / 右（纵向列）或上 / 下（横向条），起始边决定按钮贴哪端。
 *    LayoutCoordinator.setRailLayout 会解算面板所在侧并重算所有 view 的 bounds，即时生效。
 * 2. `app.side_column_position` —— 垂直标签侧栏（标签列那一列）那一段。
 *    两段可以各靠一边（标签列在右、工具图标栏在左）。
 * 3. 两侧面板位宽度（app.panel_width_left / app.panel_width_right）：面板宽度状态在
 *    主进程（LayoutCoordinator），记忆落在这两条设置里；启动时与每次变更都灌回去。
 *
 * @param {{ getLayoutCoordinator?: () => any }} deps
 */
const {
  LAYOUT_SETTING_KEYS,
  normalizeSidebarPosition,
  normalizeRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  normalizeRailExpandMode,
  normalizeRailPinned,
  normalizeRailWidth,
  RAIL_COLLAPSED_WIDTH,
  RAIL_WIDTH_MIN
} = require('@hira-ng/shared-types/src/layout.mjs')

/**
 * 工具图标栏（rail）位置 + 起始边 —— 一个生效器管一组强相关状态，避免拆成三个
 * 各自重排一次布局。`setRailLayout` 内部会解算「面板在哪一侧」并统一重算 bounds。
 */
function createSidebarPositionApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const keys = [
    LAYOUT_SETTING_KEYS.toolSidebarPosition,
    LAYOUT_SETTING_KEYS.toolRailHorizontalAlign,
    LAYOUT_SETTING_KEYS.toolRailVerticalAlign
  ]
  return {
    id: 'layout-rail-position',
    keys,
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setRailLayout !== 'function') return
      lc.setRailLayout({
        position: normalizeRailPosition(settings.get(LAYOUT_SETTING_KEYS.toolSidebarPosition)),
        horizontalAlign: normalizeRailHorizontalAlign(
          settings.get(LAYOUT_SETTING_KEYS.toolRailHorizontalAlign)
        ),
        verticalAlign: normalizeRailVerticalAlign(
          settings.get(LAYOUT_SETTING_KEYS.toolRailVerticalAlign)
        )
      })
    }
  }
}

/**
 * 垂直标签侧栏（侧栏区那一列）所在侧的生效器。
 *
 * 与上一条**分开**：纵向轨道上相邻的两段各有自己的侧，用户可以把标签列与工具图标栏
 * 分到两边。渲染层也会把侧随占宽一起上报（它才是量到宽度的那一方），两条路径同源同值，
 * 这里负责让**新窗口 / 启动瞬间**在渲染层上报之前就已经落在正确一侧。
 */
function createSideColumnPositionApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-side-column-position',
    keys: [LAYOUT_SETTING_KEYS.sideColumnPosition],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setSideColumnSide !== 'function') return
      const pos = settings.get(LAYOUT_SETTING_KEYS.sideColumnPosition)
      lc.setSideColumnSide(normalizeSidebarPosition(pos))
    }
  }
}

/**
 * 两侧面板位宽度（用户拖拽后由面板宿主写回；本生效器负责读回并灌进每个窗口的布局）。
 *
 * 为什么必须有它：布局只认 LayoutCoordinator 里的宽度（`_panelWidths`），而那份状态是
 * 每个窗口一份、进程重启即丢。没有它，重启后（或新开的窗口里）面板会回到默认宽度，
 * 直到用户再拖一次 —— "记忆"就形同虚设。
 */
function createPanelWidthApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-panel-width',
    keys: [
      'app.panel_width_left', 'app.panel_width_right',
      // 钉住位的宽度**各记各的**：钉住面板通常更窄，拖它不该改到普通位。
      'app.panel_pinned_width_left', 'app.panel_pinned_width_right'
    ],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setPanelWidth !== 'function') return
      for (const side of ['left', 'right']) {
        const n = Math.floor(Number(settings.get(`app.panel_width_${side}`)))
        // 非法 / 未设置的值交给主进程的区间校验挡掉（200~600），这里不重复定义一遍
        if (Number.isFinite(n)) lc.setPanelWidth(n, side, 'normal')
        const p = Math.floor(Number(settings.get(`app.panel_pinned_width_${side}`)))
        if (Number.isFinite(p)) lc.setPanelWidth(p, side, 'pinned')
      }
    }
  }
}

/**
 * 可展开 rail 的“用户偏好 → 当前原生宽度”。
 *
 * 面板打开造成的自动收起是运行期呈现，不写设置；这里只恢复用户最近一次手动选择。
 * 新窗口建好后、设置页改宽度、按钮编辑后重建都会经过同一条入口。
 */
function createRailWidthApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-rail-width',
    keys: [LAYOUT_SETTING_KEYS.toolRailExpandMode, LAYOUT_SETTING_KEYS.toolRailWidth],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setRailWidth !== 'function') return
      const mode = normalizeRailExpandMode(settings.get(LAYOUT_SETTING_KEYS.toolRailExpandMode))
      const expanded = mode !== 'rail'
      const width = Math.max(
        RAIL_WIDTH_MIN,
        normalizeRailWidth(settings.get(LAYOUT_SETTING_KEYS.toolRailWidth))
      )
      lc.setRailWidth(expanded ? width : RAIL_COLLAPSED_WIDTH)
    }
  }
}

/** rail 固定态持久化：启动、切 profile/空间与热更新共用，作用于全部窗口。 */
function createRailPinnedApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-rail-pinned',
    keys: [LAYOUT_SETTING_KEYS.toolRailPinned],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setRailPinned !== 'function') return
      lc.setRailPinned(normalizeRailPinned(settings.get(LAYOUT_SETTING_KEYS.toolRailPinned)))
    }
  }
}

/**
 * 独立侧栏（Web Sidebar）**位置偏好**的生效器。
 *
 * 纵向轨道上的第三段，与工具区（rail + 面板）是"**跟随**"关系：
 *   · `'auto'`（默认）—— 落在工具区**所在的那一侧**（工具区换边它跟着换边）；
 *   · `'left'` / `'right'` —— 用户显式钉死（在设置里选，或**拖顶条**拖过去）。
 *     要"与工具区错开一侧"就选这里 —— 那是一次显式决定，不该由默认值替他做。
 *
 * 解析成实际侧别的算术只有一份（`shared-types#resolveWebSidebarSide`），
 * 这里只把偏好原样递过去 —— 不在这里重复一遍"什么值算哪一侧"。
 *
 * 与「宽度」那条 applier 分开：两者是不同维度的偏好（位置 / 宽度），
 * 一条挂了不该连累另一条。
 */
function createWebSidebarPositionApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-web-sidebar-position',
    keys: [LAYOUT_SETTING_KEYS.webSidebarPosition],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setWebSidebarPosition !== 'function') return
      const pos = settings.get(LAYOUT_SETTING_KEYS.webSidebarPosition)
      // 非法 / 未设置 → 主进程侧回落到 'auto'，这里不重复定义默认值
      lc.setWebSidebarPosition(pos === 'left' || pos === 'right' ? pos : 'auto')
    }
  }
}

/**
 * 独立侧栏（Web Sidebar）的**记忆**：宽度。
 *
 * 为什么只记宽度、不记"开着还是关着"：显隐是**过程**（用户当下的动作），
 * 不是资产 —— 重启时把侧栏自动弹出来会打断用户（与"标签页不自动重开"同一条理由）。
 * 而宽度是**偏好**，记错一次就得每次重拖。
 */
function createWebSidebarApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'layout-web-sidebar',
    keys: [LAYOUT_SETTING_KEYS.webSidebarWidth],
    apply({ settings }) {
      const lc = typeof deps.getLayoutCoordinator === 'function' ? deps.getLayoutCoordinator() : null
      if (!lc || typeof lc.setWebSidebarWidth !== 'function') return
      const w = Math.floor(Number(settings.get(LAYOUT_SETTING_KEYS.webSidebarWidth)))
      // 非法 / 未设置交给主进程的区间校验挡掉（200~600），这里不重复定义一遍
      if (Number.isFinite(w)) lc.setWebSidebarWidth(w)
    }
  }
}

export {
  createSidebarPositionApplier,
  createSideColumnPositionApplier,
  createPanelWidthApplier,
  createRailWidthApplier,
  createRailPinnedApplier,
  createWebSidebarApplier,
  createWebSidebarPositionApplier
}

/**
 * panels/main.js —— 面板进程的**薄引导**（bootstrap）。
 *
 * 面板 = 独立 WebContentsView，**关闭即销毁**：每点开一次都是一次冷进程启动。
 * 于是"多快画出第一帧"直接等于用户感受到的跟手感。本文件据此被切成两段时序：
 *
 *   ① 主 chunk 求值（本文件）：只做**零依赖**的事 —— 注入基底样式、画壳（标题栏 + 空内容区）、
 *      起主题、开拉面板实现。静态依赖只剩 `panelShell.ts`（纯 DOM）、主题控制器与桥。
 *   ② `import('./host.js')`：一切重活 —— 十几个 IPC 客户端、插件插槽、工具栏、拖拽手柄、
 *      面板实现的解析与挂载。它们全部在**壳已经出现在屏幕上之后**才求值。
 *
 * 为什么值得这么拆：`ui-common` 是四十多条 `export *` 的重桶（tabRowList / pinGrid /
 * tabContextMenu …），面板进程原先在首帧就要把它们全部求值完 —— 只为了画一个标题栏。
 * 现在首帧静态图 ≈ 壳 + 主题 + 5 份 CSS，重活全部延后，且与"壳已可见"重叠进行。
 *
 * 这个文件不认识任何一个具体面板（见 `registry.js` 的约定式发现），也不认识宿主细节
 * （见 `host.js`）。加一个面板 = 加一个 ui-panel-* 包 + 一个插件 manifest。
 */

import { injectPanelBaseStyles, createPanelShell, setOverlayDragSuppressed } from '@hira-ng/ui-common/src/panelShell'
import { setChromeDragSuppressed } from '@hira-ng/ui-common/src/dragRegion'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge } from '../shared/bridge.js'
import { createThemeController } from '../shared/theme-controller.js'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import '@hira-ng/shared-ui-tokens/components.css'
import { panelModuleKeys, loadPanelDefinitionById } from './registry.js'

// ① 样式与壳：纯 DOM，同步完成 → 第一帧就有底色 + 标题栏。
injectPanelBaseStyles(document)

const root = document.getElementById('root') as HTMLElement
const qs = new URLSearchParams(window.location.search)
const panelId = qs.get('panelId') || 'unknown-panel'
/**
 * 主进程随页面加载附带的**加载提示**（见 main/panel-views#ensure）。
 *
 * 它们让本进程在**模块求值阶段**就知道「这块面板叫什么、属于哪个插件」，
 * 于是第一帧（标题栏 + 内容区底板）不依赖任何 IPC 往返。
 * 缺省为空串：旧版页面 / 目录晚到的场景仍走「问一次目录」的降级路径（结果一致）。
 */
const urlTitle = (qs.get('title') || '').trim()
const urlPluginId = (qs.get('pluginId') || '').trim()
/** 面板图标名（目录里的 `icon`）——标题栏靠它渲染那个 16px 字形。 */
const urlIcon = (qs.get('icon') || '').trim()

const bridge = getHiraBridge()
const title = urlTitle || panelId

/**
 * 壳的关闭按钮 = 「切换」这条既有意图（不带 side ⇒ 纯开关，面板自己的按钮走这条）。
 *
 * 为什么直接发路由而不是 `panelsClient.toggle`：那会把 `hira-client`（十一个客户端 +
 * 插件/主题等一大簇）拉进**首帧**静态图，只为一次点击的语义。路由常量本身就是契约，
 * 客户端方法只是它的薄包装 —— 这里用包装的价格远高于收益。
 */
const shellApi = createPanelShell(document, title, {
  panelId,
  icon: urlIcon,
  /**
   * 图钉 = 「固定面板」：钉住后这块面板**常驻**（占同侧更靠网页的那一格），
   * 从 rail / 导航栏切换面板只替换普通位，不会关闭或换掉它。
   *
   * 状态**不乐观切换**：主进程是唯一真值，响应回来才落 UI；之后的外部变更
   * （被别的面板顶到普通位、换边）由 host 的 side-changed 推送补齐。
   */
  pin: {
    onToggle: () => {
      let pending
      try { pending = bridge.provider.invoke(IPC_ROUTES.panelPin, { panelId }) } catch (_) { return }
      Promise.resolve(pending)
        .then((res) => { if (res) shellApi.setPinned(!!res.pinned) })
        .catch(() => {})
    }
  },
  onClose: () => {
    try { bridge.provider.invoke(IPC_ROUTES.panelToggle, { panelId }) } catch (_) {}
  }
})
const { shell, content } = shellApi
if (root && shell.parentNode !== root) root.appendChild(shell)
// 骨架标记：内容区在"确实要等"时显示延迟 shimmer（CSS 决定延迟，见 panelShell）。
content.classList.add('panel-booting')

// 主题：两处令牌（配色 / 字体 / 圆角）必须与外壳同源，否则面板与工具栏会各走一套色。
const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

// 模态浮层（总览 / 按钮编辑）铺满窗口时，本面板标题栏的拖拽区必须让位 ——
// `-webkit-app-region` 是窗口级合并的，浮层盖不住它；不让位的话浮层上的点击会被
// 窗口当作「拖动标题栏」吃掉（见 ui-common#setOverlayDragSuppressed）。
bridge.on.subscribe(IPC_EVENTS.overlayModal, (payload) => {
  setOverlayDragSuppressed(document, !!(payload && payload.open))
})

bridge.on.subscribe(IPC_EVENTS.chromeDragSuppressed, (payload) => {
  setChromeDragSuppressed(document, !!(payload && payload.suppressed))
})

// ② 面板实现**在壳画完之后立刻开拉**，与 host 模块求值并行：
//    `panelModuleKeys` 是纯字符串查表（不 import 任何面板）—— 命中不了就交给 host
//    走"插件自带 render 入口 / 全量索引"的兜底，这里不白跑。
const prefetched = panelModuleKeys(panelId).length
  ? loadPanelDefinitionById(panelId).catch(() => null)
  : null

// ③ 重活延后：host 求值完就接手（它自己会在内容区就位时撤掉 panel-booting）。
import('./host.js')
  .then((mod) => mod.startPanelHost({ root, shellApi, panelId, urlTitle, urlPluginId, prefetched, bridge }))
  .catch((e) => {
    console.error('[panels] host failed:', e)
    content.classList.remove('panel-booting')
    const failed = document.createElement('div')
    failed.style.cssText = 'padding: 32px 16px; text-align: center; color: var(--hira-text-secondary, #6b7280); font-size: 12px;'
    failed.textContent = `面板 ${panelId} 装配失败：${(e && e.message) || e}`
    content.appendChild(failed)
  })


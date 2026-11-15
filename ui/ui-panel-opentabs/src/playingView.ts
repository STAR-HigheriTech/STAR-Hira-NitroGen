// @ts-check
/**
 * 「标签」面板的「播放中」分段 —— 正在出声的标签（原独立面板 `ui-panel-media`）。
 *
 * 归并理由与「已固定 / 已归档」同一族：**媒体列表就是打开中的标签的一个子集**
 * （判据就是标签条上那个 `t.isPlaying`，两处不可能对不上）。给它单开一个 rail
 * 入口，用户得多判断一次"我要找的页面算不算媒体"—— 而这不需要判断。
 *
 * ── 与「打开中」分段的差异只有三处参数（不复制任何接线）────────────────────
 *   · `filter`    = 只留 `isPlaying`；
 *   · `source`    = 'list'：播放中的标签可能藏在**折叠的标签组**里，投影只补发
 *                   组内的活动成员，用投影会漏掉正在响的那一页；
 *   · `emptyText` = 本分段专属空态。
 * 行内音量按钮 / 右键菜单 / hover 预览 / 关闭按钮 / 拖拽因此与别处**完全一致**
 * （全部来自 `@hira-ng/ui-common#createTabListHost`，见 tabListHost.ts）。
 *
 * ── 解耦 ────────────────────────────────────────────────────────────────
 * 零 IPC、零 electron：数据走注入的 `clients.tabs`（自订阅），动作全由列表宿主
 * 经 ctx 端口发出。本视图是哑组件，由分段壳（index.js）决定何时装配 / 销毁。
 */

import type { PanelContext } from '@hira-ng/ui-common'
import { injectPanelStyles, injectTabRowStyles, createTabListHost } from '@hira-ng/ui-common'
import type { TabListHostContext, TabListHostController, TabRowItem } from '@hira-ng/ui-common'

export function injectPlayingViewStyles(doc: Document): void {
  injectPanelStyles(doc)
  injectTabRowStyles(doc)
}

/**
 * @param {Document} doc
 * @param {PanelContext} [ctx] 面板宿主端口（clients / menu / createTabRowMenu / previewOverlay …）
 * @returns {TabListHostController}
 */
export function createPlayingView(doc: Document, ctx: PanelContext = {}): TabListHostController {
  const hostCtx = ctx as TabListHostContext
  return createTabListHost(doc, {
    clients: hostCtx.clients,
    createTabRowMenu: hostCtx.createTabRowMenu,
    menu: hostCtx.menu,
    previewOverlay: hostCtx.previewOverlay,
    dragKind: 'media',
    showAddButton: false,
    filter: (tab: TabRowItem) => tab.type !== 'stack' && tab.isPlaying === true,
    emptyText: '没有正在播放的标签',
    source: 'list',
    // 面板住在独立 WebContentsView：标签数据只能自己拉（见 index.js 头注释）
    autoSubscribe: true
  })
}

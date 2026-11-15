/**
 * 目录条目的**打开语义** —— 一个入口点下去，到底该发生什么。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 * 目录项（`panels-client#catalog`）现在有三种去向：
 *   · **普通项** → 开侧栏面板（`panel:toggle`）；
 *   · **声明了 opensWindow 的项** → 开一个独立子窗口（`window:open`）；
 *   · **声明了 opensPage 的项** → 在标签页里打开内部页 `hira://<host>`。
 *
 * 这类"判断 + 派发"如果写在每个入口里，就会随入口数量增长而复制：
 * rail、navbar、以后的命令面板 / 快捷键 / 菜单各写一遍 —— 迟早出现
 * "rail 点了开窗口、navbar 点了开面板"这种同一个图标两个行为的裂缝。
 *
 * 于是把它收成一处：**入口只知道"用户点了这一格"，去哪由条目自己说了算。**
 * 判据（`panelEntryWindowType` / `panelEntryPageHost`）住在纯层
 * `shared-types/panel-entry.mjs`，与目录形状的其余部分同一个家 ——
 * 本文件只负责把判据接到三条通道上。
 *
 * 分层：本文件在 APPS 层（renderer），可以 import 客户端；ui/* 不得反向依赖它，
 * 所以它只被 apps 的编排层调用，不进任何 ui 包。
 */
import { panelEntryPageHost, panelEntryWindowType } from '@hira-ng/shared-types/src/panel-entry.mjs'
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import { openUrlPreferExistingTab } from '@hira-ng/ui-common/src/bookmark-open'
import type { CatalogItem } from '@hira-ng/ui-common/src/icons'
import { getHiraBridge } from './bridge.js'
import { panelsClient } from './panels-client.js'
import { tabsClient } from './tabs-client.js'

/**
 * 打开一个目录条目。
 *
 * @param {object} entry 目录项（`panelEntryToCatalogItem` 的产物，带 opensWindow / opensPage）
 * @param {{ side?: 'left'|'right' }} [opts] 仅面板形态用（见 panelsClient.toggle）
 * @returns {Promise<{ open: boolean, panelId: string } | null>}
 *   null = 这是个动作（开了窗口 / 标签页），**没有"打开/关闭"两态**，调用方不要把图标点亮。
 */
export function openCatalogEntry(entry: { id: string; [key: string]: unknown }, opts?: { side?: 'left'|'right' }) : Promise<{ open: boolean, panelId: string } | null> {
  if (!entry || !entry.id) return Promise.resolve(null)

  const windowType = panelEntryWindowType(entry)
  if (windowType) {
    // 动作型：开子窗口。**不返回 open 状态** —— 它没有可开关的界面，
    // 点亮图标只会让用户以为"点出了一个面板"（与 rail 的插件槽图标同一条判据）。
    return getHiraBridge().provider.invoke('window:open', { type: windowType })
      .then(() => null)
      .catch((e) => {
        console.error('[entry] open window failed:', windowType, e && e.message)
        return null
      })
  }

  const pageHost = panelEntryPageHost(entry)
  if (pageHost) {
    // 动作型：在标签页里开内部页。与子窗口同一条判据 —— 去的是页面，不是面板，
    // 所以同样没有"打开/关闭"两态。`pageUrl()` 负责 host → `hira://<host>/`，
    // 未登记的 host 由页面层落兜底，本文件不复制那张表。
    return openUrlPreferExistingTab(pageUrl(pageHost), tabsClient)
      .then(() => null)
      .catch((e) => {
        console.error('[entry] open page failed:', pageHost, e && e.message)
        return null
      })
  }

  return panelsClient.toggle(entry.id, opts)
}

/**
 * 从一份目录里按 id 取条目（入口的点击回调只拿得到 id）。
 * 找不到返回 null —— 调用方据此"什么都不做"（目录里没有它，本就不该有入口）。
 *
 * @param {object[]} catalog
 * @param {string} id
 */
export function findCatalogEntry<T extends { id?: unknown }>(catalog: readonly T[], id: string): T | null {
  const key = String(id == null ? '' : id)
  return (Array.isArray(catalog) ? catalog : []).find((p) => p && p.id === key) || null
}

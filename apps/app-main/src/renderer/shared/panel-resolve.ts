/**
 * panel-resolve.js —— 面板实现的**三级解析**（宿主无关）。
 *
 * 原本这段逻辑住在 `panels/host.js`（侧栏面板宿主）。"面板 → 独立窗口"成为通用能力
 * （`detached-panel`）之后，两个宿主都要回答同一个问题：「这块 panelId 的界面从哪来」。
 * 抄第二份必然漂移 —— 于是抽到这里，两个宿主 shared 一份。
 *
 * 三级顺序（越靠前越"更具体的声明"）：
 *   ① 插件自带的 `render` 入口（可执行代码）
 *   ② 插件自带的 `ui` 面（声明式 `.html` / `.xaml`，沙箱 iframe 装配）
 *   ③ 回落到 `ui/ui-panel-*` 包（约定式发现，靠目录名撞上 id）
 *
 * 判据与理由见 `panels/host.js` 的历史注释（那一份仍然有效，这里只是搬家）。
 */

import { pluginsClient } from './hira-client.js'
import { hasRendererEntry, loadPanelDefinitionFrom, getRendererLoadError, getRendererPanelIds } from './plugin-renderer.js'
import { createPanelUiDefinition } from './panel-ui-frame.js'
import { getActiveManifests } from './plugin-slots.js'
import { loadPanelDefinitionById } from '../panels/registry.js'
import type { PanelDefinition } from './panel-definition.js'
import type { PanelCatalogEntry } from './panels-client.js'
import { errorMessage } from './error-message.js'

/**
 * panelId → 最后一次解析失败的具体原因。
 *
 * 为什么要有它：宿主在 `def == null` 时只能显示一句「尚未实现」，而真实原因可能完全不同
 * （插件没写 render / 写了但加载崩了 / 加载成功但这个 id 没导出 / 插件没启用）。
 * 把原因留在这里，宿主就能把**能查的信息**摆给用户和插件作者，而不是让人猜。
 *
 * @type {Map<string, { pluginId: string, stage: 'load'|'no-panel'|'no-entry'|'no-manifest', message: string, panelIds: string[] }>}
 */
const resolveErrors: Map<string, { pluginId: string, stage: 'load'|'no-panel'|'no-entry'|'no-manifest', message: string, panelIds: string[] }> = new Map()

/**
 * 取某块面板上一次解析失败的原因（成功时返回 null）。
 * @param {string} panelId
 */
export function getPanelResolveError(panelId: string) {
  return resolveErrors.get(String(panelId || '')) || null
}

/**
 * @param {string} panelId
 * @param {string} [pluginIdHint] 归属插件 id（通常来自 URL，无需等目录）
 * @param {Promise<object|null>|null} [prefetched] 已提前开拉的 ui 包实现
 * @param {Promise<object|null>|null} [entryReady] 目录条目（只在与 hint 都没有时才需要）
 * @returns {Promise<object|null>}
 */
export async function resolvePanelDefinition(panelId: string, pluginIdHint?: string, prefetched: Promise<PanelDefinition|null>|null = null, entryReady: Promise<PanelCatalogEntry|null>|null = null) : Promise<PanelDefinition|null> {
  const key = String(panelId || '')
  resolveErrors.delete(key)
  let pluginId = pluginIdHint ? String(pluginIdHint) : ''
  if (!pluginId && entryReady) {
    const entry = await entryReady.catch(() => null)
    pluginId = entry && entry.pluginId ? String(entry.pluginId) : ''
  }
  if (pluginId) {
    try {
      // 清单直接用**插槽激活刚读到的那一份**；激活还没回来时才自己问（并发会合并）。
      const known = getActiveManifests()
      const manifests = known.length ? known : await pluginsClient.list()
      const manifest = (manifests || []).find((p) => p.id === pluginId)
      if (!manifest) {
        resolveErrors.set(key, {
          pluginId,
          stage: 'no-manifest',
          message: `插件 ${pluginId} 不在已启用列表里（可能已禁用 / 安装不完整）`,
          panelIds: []
        })
      } else if (manifest.isFirstParty === true && hasRendererEntry(manifest)) {
        const fromPlugin = await loadPanelDefinitionFrom(manifest, panelId)
        if (fromPlugin) return fromPlugin
        const loadError = getRendererLoadError(pluginId)
        resolveErrors.set(key, loadError
          ? { pluginId, stage: 'load', message: loadError, panelIds: [] }
          : { pluginId, stage: 'no-panel', message: '', panelIds: getRendererPanelIds(pluginId) })
      } else {
        // ② 声明式 UI 面：manifest 的 `ui` 入口经主进程整理成 `panelUi[]`。
        const uiFace = Array.isArray(manifest.panelUi)
          ? manifest.panelUi.find((ui) => ui && ui.panelId === panelId)
          : null
        if (uiFace) {
          return createPanelUiDefinition({
            pluginId,
            panelId,
            entry: uiFace.entry,
            kind: uiFace.kind,
            url: uiFace.url,
            title: uiFace.title || '',
            permissionLevel: manifest.permissionLevel,
            grantedPermissions: manifest.grantedPermissions,
            isFirstParty: manifest.isFirstParty
          })
        }
        resolveErrors.set(key, {
          pluginId,
          stage: 'no-entry',
          message: hasRendererEntry(manifest)
            ? `插件 ${pluginId} 的可执行 render 入口仅允许第一方插件；社区插件请声明式 ui 面（ui/html/view/entry → .html/.xaml）`
            : `插件 ${pluginId} 的 manifest 既没有可执行的 render 入口（.js/.mjs/.cjs），也没有声明式 ui 面（ui/html/view/entry → .html/.xaml）`,
          panelIds: []
        })
      }
    } catch (e) {
      // 插件路径失败不该挡住 ui 包那条路（降级：至少还能显示点什么）
      console.error(`[panels] 插件 ${pluginId} 的渲染入口解析失败:`, e)
      resolveErrors.set(key, {
        pluginId,
        stage: 'load',
        message: errorMessage(e, String(e)),
        panelIds: []
      })
    }
  }
  const fallback = await Promise.resolve(prefetched || loadPanelDefinitionById(panelId)).catch(() => null)
  // 兜底成功时把中间失败原因清掉：它只服务于"最终没实现"的占位文案。
  if (fallback) resolveErrors.delete(key)
  return fallback
}


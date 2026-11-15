/**
 * detached-panel.js —— **通用「面板独立窗口」**的挂载器（subwindow 入口的一种 type）。
 *
 * 这是"一块面板，两种宿主"里**窗口那一半**：侧栏面板宿主（`panels/host.js`）把面板
 * 塞进主窗口的侧栏槽位；本文件把**同一份** panelDefinition 塞进一个独立窗口。
 *
 * 三条不可动摇的边界（否则就又成了两套实现）：
 *   1. **面板身份来自运行时**：URL 的 `?payload={"panelId":"…"}`（由
 *      `openSubWindowByType` 透传）。本文件不认识任何具体面板 —— 换任何面板都成立。
 *   2. **端口与解析共用**：`shared/panel-context.js` / `shared/panel-resolve.js`
 *      是唯一实现，两个宿主都只是调用方。
 *   3. **不含侧栏专属物**：宽度拖拽手柄 / "我在哪一侧" / 外侧浮层 —— 那些只在
 *      200~600px 的槽位里有意义；窗口自己可缩放、浮层可覆盖在 DOM 之上。
 */

import { injectPanelStyles } from '@hira-ng/ui-common/src/panelKit'
import { defineRendererSlots, activateRendererSlots } from '../../shared/plugin-slots.js'
import { panelsClient } from '../../shared/hira-client.js'
import { createPanelContext, refreshPanel, setPanelRefresh } from '../../shared/panel-context.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { slotPort } from '../../shared/panel-slot-port.js'
import { resolvePanelDefinition } from '../../shared/panel-resolve.js'
import { mountPanelTransferButton, mountPanelPageButton } from '../../shared/panel-transfer.js'
import { normalizePanelInstance } from '../../shared/panel-instance.js'
import type { PanelInstance } from '../../shared/panel-definition.js'

// 与侧栏面板宿主声明**同一组**官方渲染侧插槽：同一个 panelDefinition 到哪儿都该能
// 调同样的扩展点（`slots.call('note.card-renderer', …)` 不会因为换了窗口就变 null）。
defineRendererSlots([
  'side-panel.panel-render-slot',
  'side-panel.panel-header-renderer',
  'download.state-badge-renderer',
  'bookmark.tree-renderer-item',
  'note.card-renderer',
  'note.capture-provider',
  'note.export-format'
])

injectPanelStyles(document)

/** 从 URL 取面板身份与宿主提示。 */
function readTarget(params: URLSearchParams): {
  panelId: string
  pluginId: string
  title: string
  payload: Record<string, unknown>
} {
  let payload: Record<string, unknown> = {}
  const raw = params.get('payload')
  if (raw) {
    try { payload = JSON.parse(raw) || {} } catch (_) { payload = {} }
  }
  const panelId = String(payload.panelId || params.get('panelId') || '').trim()
  const pluginId = String(payload.pluginId || '').trim()
  const title = String(payload.title || '').trim()
  return { panelId, pluginId, title, payload }
}

function setWindowTitle(text: string) {
  const el = document.getElementById('title')
  if (el) el.textContent = text
  document.title = text
}

function showMountNotice(content: HTMLElement, message: string): void {
  content.textContent = ''
  const notice = document.createElement('p')
  notice.style.cssText = 'color:var(--hira-text-secondary,#6b7280);font-size:13px;padding:24px 16px;text-align:center'
  notice.textContent = message
  content.appendChild(notice)
}

/**
 * 标题栏动作区：把「停靠回侧栏」按钮插在窗口控制簇**左边**。
 *
 * 窗口控制簇（最小化 / 最大化 / 关闭）由 `subwindow/main.js` 在窗口模块挂载**之前**
 * 就放进 `#header-actions` 了，所以这里必须 `insertBefore` 而不是 append ——
 * append 会把按钮排到关闭键右侧，看着像第二个关闭键。
 *
 * @param {string} panelId
 * @param {'dock'|'both'|undefined} presentation
 * @param {string|null} hostPage 面板的内部页形态（目录项 `hostPage`，没有则 null）
 * @param {() => unknown} getState
 */
function mountHeaderTransfer(
  panelId: string,
  presentation: 'dock' | 'both' | undefined,
  hostPage: string | null,
  getState: () => unknown
) {
  const host = document.getElementById('header-actions')
  if (!host) return null
  let slot = host.querySelector<HTMLElement>('[data-panel-transfer-slot]')
  if (!slot) {
    slot = document.createElement('div')
    slot.setAttribute('data-panel-transfer-slot', '')
    slot.style.cssText = 'display: flex; align-items: center; gap: 4px; padding-right: 6px;'
    host.insertBefore(slot, host.firstChild)
  }
  const btn = mountPanelTransferButton(slot, {
    panelId,
    presentation,
    detached: true,
    serialize: getState
  })
  // 窗口形态同样给「在页面中打开」—— 三种形态互相可达，用户不必先停靠再开页。
  mountPanelPageButton(slot, { hostPage })
  return btn
}

/**
 * @param {{ type: string, params: URLSearchParams, content: HTMLElement }} opts
 */
export async function mountDetachedPanel({ params, content }: { params: URLSearchParams; content: HTMLElement }) {
  const { panelId, pluginId, title, payload } = readTarget(params)
  if (!panelId) {
    showMountNotice(content, '独立面板窗口缺少 panelId（应通过 ?payload={"panelId":"…"} 打开）')
    return
  }

  const bridge = window.hira
  if (!bridge) {
    showMountNotice(content, '渲染桥不可用（preload 未加载）')
    return
  }

  setWindowTitle(title || panelId)

  // 目录（只为标题校正）与插槽激活并行起跑 —— 都不该挡住面板本体。
  const catalogReady = panelsClient.catalog().catch(() => [])
  const slotsReady = activateRendererSlots({ withPanels: true, panelId })

  const def = await resolvePanelDefinition(panelId, pluginId, null, catalogReady.then(
    (catalog) => (catalog || []).find((p) => p.id === panelId) || null
  ))
  await slotsReady.catch(() => {})

  const entry = (await catalogReady).find((p) => p.id === panelId) || null
  if (!title && entry && entry.title) setWindowTitle(entry.title)

  if (!def) {
    showMountNotice(content, `面板 ${panelId} 没有可用的界面实现`)
    return
  }

  if (typeof def.injectStyles === 'function') {
    try { def.injectStyles(document) } catch (e) { console.error(`[detached-panel] ${panelId} injectStyles 失败:`, e) }
  }

  /** 挂载结果（切换按钮的 serialize 从这里取，见下面的晚绑定闭包）。 */
  let mountedRef: PanelInstance | null = null

  /**
   * 标题栏的「停靠回侧栏」—— 与侧栏宿主是**同一个按钮、同一份实现**
   * （`shared/panel-transfer.js`）。窗口形态只多一个 `detached: true`。
   */
  const presentation = entry?.presentation === 'dock' || entry?.presentation === 'both' ? entry.presentation : 'dock'
  const hostPage = typeof entry?.hostPage === 'string' ? entry.hostPage : null
  mountHeaderTransfer(panelId, presentation, hostPage, () =>
    mountedRef && typeof mountedRef.serialize === 'function' ? mountedRef.serialize() : undefined
  )

  // `host: 'window'` 是**记忆归属**：窗口自己记"当前会话"，与侧栏 / 内部页互不干扰。
  const ctx = createPanelContext({ bridge, panelId, compact: false, previewOverlay: null, slots: slotPort, host: 'window' })
  // 窗口形态额外把"被拎出来"的事实告诉面板（面板可据此隐藏"拆出窗口"按钮）。
  ctx.detached = true
  ctx.payload = payload

  let mounted: PanelInstance | null = null
  try {
    mounted = normalizePanelInstance(await def.mount(document, ctx))
  } catch (e) {
    console.error(`[detached-panel] ${panelId} mount 失败:`, e)
    const message = e instanceof Error ? e.message : String(e)
    showMountNotice(content, `面板 ${panelId} 装配失败：${message}`)
    return
  }
  mountedRef = mounted
  setPanelRefresh(mounted && typeof mounted.refresh === 'function' ? mounted.refresh : null)
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refreshPanel()
    }, 16)
  }
  const offProfile = bridge.on.subscribe(IPC_EVENTS.profileChanged, scheduleRefresh)
  const offExtension = bridge.on.subscribe(IPC_EVENTS.extensionChanged, (payload) => {
    const reason = payload && typeof payload === 'object'
      ? String((payload as Record<string, unknown>).reason || '')
      : ''
    if (reason.startsWith('profile-context')) scheduleRefresh()
  })
  window.addEventListener('pagehide', () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    offProfile()
    offExtension()
  }, { once: true })
  content.classList.remove('panel-booting')
  if (mounted && mounted.element) {
    // **先清掉入口的占位**（`index.html#content` 里那句「加载中...」）再挂面板。
    // 只 append 不清占位时，那句文字会永远留在面板上方，把 `height:100%` 的面板
    // 往下顶 20px —— 底部内边距被挤出可视区，表现就是"内容贴住窗口底边"。
    content.textContent = ''
    content.appendChild(mounted.element)
  }
  // 拆出窗口那一刻的状态随 payload 带过来（见 main/panel-presentation.js#detach）。
  // 窗口是冷进程，状态只有这一条路能到 —— 必须在 mount 之后立刻回填。
  if (mounted && typeof mounted.restore === 'function' && payload.state != null) {
    try { mounted.restore(payload.state) } catch (e) {
      console.error(`[detached-panel] ${panelId} restore 失败:`, e)
    }
  }
}


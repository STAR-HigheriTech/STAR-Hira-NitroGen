import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

export interface SlotRenderItem {
  key: string
  pluginId: string | null
  descriptor: unknown
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/**
 * 渲染侧插槽客户端（PART7 §7.3 的渲染层那一半）。
 *
 * 用法固定为「取一次描述符 → 画 → 点击时用 key 派发」：
 *
 *   const items = await slotsClient.render('side-panel.toolbar-action-slot', { panelId })
 *   for (const { key, descriptor } of items) {
 *     // descriptor 里只有纯数据（函数已被主进程剥掉）
 *     button.onclick = () => slotsClient.dispatch('side-panel.toolbar-action-slot', key, { panelId })
 *   }
 *
 * ⚠ 只能用于主进程白名单里的插槽（`side-panel.*`）——
 * 传别的插槽 id 会被拒绝并返回空数组，不会静默生效。
 */
export const slotsClient = {
  /**
   * 执行插槽，拿可序列化描述符。
   * @param {string} slotId
   * @param {unknown} [payload]
   * @returns {Promise<Array<{ key: string, pluginId: string|null, descriptor: unknown }>>}
   */
  render(slotId: string, payload?: unknown): Promise<SlotRenderItem[]> {
    return invoke(IPC_ROUTES.slotsRender, { slotId, payload }).then((res) => {
      return Array.isArray(res.items) ? res.items as unknown as SlotRenderItem[] : []
    })
  },

  /**
   * 按实现键派发（调用该实现的 onSelect）。
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  dispatch(slotId: string, key: string, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
    return invoke(IPC_ROUTES.slotsDispatch, { slotId, key, payload })
  }
}



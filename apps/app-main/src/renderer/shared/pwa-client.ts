/**
 * PWA 领域客户端 —— 与 bookmarks-client / totp-client 同构：
 * invoke 全走 IPC_ROUTES 枚举、推送全走 IPC_EVENTS 枚举，不留裸字符串通道。
 *
 * 边界：
 *   · 这里只做「通道 → 方法」的一层翻译，不含任何规则（哪种页面可安装、装完做什么
 *     都是主进程 pwa/detect 与渲染层控制器的判断）；
 *   · 推送用引用计数单例桥订阅：N 个订阅者只挂 1 条 ipcRenderer 监听（防广播放大）。
 */

import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

const detectedListeners = new Set<(payload: JsonRecord) => void>()
const changedListeners = new Set<(payload: JsonRecord) => void>()
let bridgeSubscriptions: { detected: () => void; changed: () => void } | null = null

function ensureBridgeSubscriptions() {
  if (bridgeSubscriptions) return
  const bridge = getHiraBridge()
  bridgeSubscriptions = {
    detected: bridge.on.subscribe<JsonRecord>(IPC_EVENTS.pwaDetected, (payload) => {
      for (const fn of detectedListeners) {
        try { fn(payload) } catch (e) { console.error('[pwa-client] detected listener error', e) }
      }
    }),
    changed: bridge.on.subscribe<JsonRecord>(IPC_EVENTS.pwaChanged, (payload) => {
      for (const fn of changedListeners) {
        try { fn(payload) } catch (e) { console.error('[pwa-client] changed listener error', e) }
      }
    })
  }
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/** 订阅某个集合；返回退订函数（两路订阅都空了才真正摘掉桥监听）。 */
function subscribe(set: Set<(payload: JsonRecord) => void>, fn: (payload: JsonRecord) => void): () => void {
  set.add(fn)
  ensureBridgeSubscriptions()
  return () => {
    set.delete(fn)
    if (detectedListeners.size === 0 && changedListeners.size === 0 && bridgeSubscriptions) {
      bridgeSubscriptions.detected()
      bridgeSubscriptions.changed()
      bridgeSubscriptions = null
    }
  }
}

export const pwaClient = {
  /** 已安装应用列表。 */
  list() {
    return invoke(IPC_ROUTES.pwaList, {})
  },
  /** 单个应用（含窗口状态 / 更新状态）。 */
  get(id: string) {
    return invoke(IPC_ROUTES.pwaGet, { id })
  },
  /**
   * 为当前标签准备安装候选。
   * @param {string} [tabId] 省略 = 主进程当前活动标签
   * @returns {Promise<{ ok: boolean, reason?: string, candidateId?: string, preview?: object }>}
   */
  prepare(tabId?: string) : Promise<{ ok: boolean, reason?: string, candidateId?: string, preview?: object }> {
    return invoke(IPC_ROUTES.pwaPrepare, tabId ? { tabId } : {})
  },
  /**
   * 某标签的探测结果（不创建候选）。
   * @returns {Promise<{ state: 'none'|'installable'|'shortcut'|'installed', candidateId: string|null, appId: string|null, kind: string|null }>}
   */
  state(tabId: string) : Promise<{ state: 'none'|'installable'|'shortcut'|'installed', candidateId: string|null, appId: string|null, kind: string|null }> {
    return invoke(IPC_ROUTES.pwaState, { tabId })
  },
  /** 真正安装（candidateId 来自 prepare / pwa:detected）。 */
  install(input: JsonRecord = {}) {
    return invoke(IPC_ROUTES.pwaInstall, input)
  },
  launch(id: string) {
    return invoke(IPC_ROUTES.pwaLaunch, { id })
  },
  update(id: string) {
    return invoke(IPC_ROUTES.pwaUpdate, { id })
  },
  checkUpdates() {
    return invoke(IPC_ROUTES.pwaCheckUpdates, {})
  },
  uninstall(id: string) {
    return invoke(IPC_ROUTES.pwaUninstall, { id })
  },
  createShortcut(id: string, location: string) {
    return invoke(IPC_ROUTES.pwaCreateShortcut, { id, location })
  },
  removeShortcut(id: string, location: string) {
    return invoke(IPC_ROUTES.pwaRemoveShortcut, { id, location })
  },
  setRunOnStartup(id: string, enabled: boolean) {
    return invoke(IPC_ROUTES.pwaSetRunOnStartup, { id, enabled })
  },
  /** 当前标签探测结果变化（payload: { tabId, state, candidateId, appId, kind }）。 */
  onDetected(fn: (payload: JsonRecord) => void) {
    return subscribe(detectedListeners, fn)
  },
  /** 安装 / 卸载 / 更新状态变化（payload: { appId, action }）。 */
  onChanged(fn: (payload: JsonRecord) => void) {
    return subscribe(changedListeners, fn)
  }
}



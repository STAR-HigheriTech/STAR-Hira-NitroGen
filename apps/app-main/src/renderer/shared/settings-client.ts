import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

// 设置域客户端 —— 与 tabs-client / bookmarks-client 同构：
// invoke 全走 IPC_ROUTES 枚举，不留裸字符串通道。
// 设置变更推送（settings:changed）由各控制器直接用 bridge.on.subscribe 订阅，
// 本客户端只负责「请求方向」的薄封装，不重复引入桥订阅。

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const settingsClient = {
  /**
   * 读一个设置项的值 —— **已解包**。
   *
   * 主进程的 `settings:get` 回的是 `{ value }` 信封（见 main/settings/ipc.js）。
   * 历史上各调用方各自解包，漏解的调用方会静默拿到信封对象（按钮顺序 / 显隐
   * 就是这么在重启后丢掉的：`resolvePanelOrder({value:{...}})` 读不到 order/hidden，
   * 直接退回「全部可见 + 目录顺序」）。解包只在这一处做，调用方拿到的一律是裸值。
   *
   * @param {string} key
   * @returns {Promise<unknown>}
   */
  async get(key: string): Promise<unknown> {
    const res = await invoke(IPC_ROUTES.settingsGet, { key })
    return res && typeof res === 'object' && 'value' in res ? res.value : res
  },
  set(key: string, value: unknown) {
    return invoke(IPC_ROUTES.settingsSet, { key, value })
  },
  /**
   * 给**具名空间**写一个「按空间」的设置键（B2 / J13）。
   *
   * 与 `set` 的唯一区别是「写哪个空间」：`set` 写当前空间，这条写指定空间 ——
   * 空间编辑器要给别的空间配主题时，当前空间不是目标空间。
   * 非按空间的键会被 domain 拒绝（返回 `{ ok:false }`），调用方据此不再乐观更新 UI。
   * @returns {Promise<{ ok: boolean }>}
   */
  setForSpace(spaceId: string, key: string, value: unknown, profileId?: string) : Promise<{ ok: boolean }> {
    return invoke(IPC_ROUTES.settingsSetForSpace, { spaceId, key, value, ...(profileId ? { profileId } : {}) })
  },
  list(section?: string) {
    return invoke(IPC_ROUTES.settingsList, section ? { section } : undefined)
  },
  reset(key?: string) {
    return invoke(IPC_ROUTES.settingsReset, key ? { key } : undefined)
  },
  schema() {
    return invoke(IPC_ROUTES.settingsSchema)
  },
  /** 偏离默认值（含缺省）的键列表 */
  changedKeys() {
    return invoke(IPC_ROUTES.settingsChangedKeys)
  },
  /** 展示型 CSS 变量映射 {suffix: value} */
  cssVars() {
    return invoke(IPC_ROUTES.settingsCssVars)
  }
}



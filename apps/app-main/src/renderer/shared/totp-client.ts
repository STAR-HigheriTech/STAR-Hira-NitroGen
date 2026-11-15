import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

// TOTP 领域客户端 —— 与 notes-client / bookmarks-client 同构：
// invoke 全走 IPC_ROUTES 枚举、推送全走 IPC_EVENTS 枚举，不留裸字符串通道。
// 引用计数单例桥订阅：N 个订阅者只挂 1 条 ipcRenderer 监听（防广播放大）。
//
// ⚠ 这里**没有**"取密钥"这一类方法，将来也不该有：验证码在主进程算，
// 渲染层只拿到码与倒计时。唯一带密钥的是 exportUri（导出到别的 App 用），
// 它单独一个方法，好审计、好单独收紧。

const listeners = new Set<(payload: unknown) => void>()
let bridgeSubscription: (() => void) | null = null

function ensureBridgeSubscription() {
  if (bridgeSubscription) return
  bridgeSubscription = getHiraBridge().on.subscribe(IPC_EVENTS.totpChanged, (payload) => {
    for (const fn of listeners) {
      try {
        fn(payload)
      } catch (e) {
        console.error('[totp-client] listener error', e)
      }
    }
  })
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const totpClient = {
  /** 条目列表（无密钥字段）。 */
  list() {
    return invoke(IPC_ROUTES.totpList)
  },
  /**
   * 当前验证码。
   * @param {string} [id] 省略 = 全部条目（面板一屏要一起显示）
   * @returns {Promise<{codes:{id:string,code:string,type:string,remaining:number|null,period:number|null}[], now:number, unavailable:string[]}>}
   */
  code(id?: string) : Promise<{codes:{id:string,code:string,type:string,remaining:number|null,period:number|null}[], now:number, unavailable:string[]}> {
    return invoke(IPC_ROUTES.totpCode, id ? { id } : {})
  },
  /** 手动新增。`secret` 是明文 base32（服务端会加密，明文不落盘）。 */
  add(input: JsonRecord = {}) {
    return invoke(IPC_ROUTES.totpAdd, input)
  },
  /** 改元信息；`patch.secret` 传了才改密钥。 */
  update(id: string, patch: JsonRecord = {}) {
    return invoke(IPC_ROUTES.totpUpdate, { id, ...patch })
  },
  remove(id: string) {
    return invoke(IPC_ROUTES.totpRemove, { id })
  },
  /** 批量导入：只收 `otpauth://` URI（各家 App 的导出格式在渲染层转成 URI）。 */
  importUris(uris: string | string[]) {
    return invoke(IPC_ROUTES.totpImport, { uris: Array.isArray(uris) ? uris : [uris] })
  },
  /**
   * 导出为 `otpauth://` URI（**含密钥**）—— 给别的 App 扫码，或存进自己的备份。
   * 这是本客户端唯一会拿到密钥的方法。
   */
  exportUri(id: string) {
    return invoke(IPC_ROUTES.totpExportUri, { id })
  },
  /**
   * 联网校准本机时钟偏差（只影响算码，不改系统时间）。
   * @param {{reset?: boolean}} [options] `{ reset: true }` = 清掉偏移、回到纯本机时间
   * @returns {Promise<{ok:boolean,reason?:string,reset?:boolean,offsetMs?:number|null,measuredAt?:number|null,source?:string|null,rttMs?:number|null}>}
   */
  calibrate(options: JsonRecord = {}) : Promise<{ok:boolean,reason?:string,reset?:boolean,offsetMs?:number|null,measuredAt?:number|null,source?:string|null,rttMs?:number|null}> {
    return invoke(IPC_ROUTES.totpCalibrate, options)
  },
  /** 订阅任何来源的条目变更（payload: { reason, id }）。 */
  onChanged(fn: (payload: unknown) => void): () => void {
    listeners.add(fn)
    ensureBridgeSubscription()
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0 && bridgeSubscription) {
        bridgeSubscription()
        bridgeSubscription = null
      }
    }
  }
}



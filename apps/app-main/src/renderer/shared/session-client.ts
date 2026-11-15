import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

// 会话领域客户端 —— 两个彼此独立的层：
//   · 自动会话：单个快照（启动恢复用），read/stats/save/restore/clear/exists
//   · 命名会话：N 个有名字的快照（N14），listNamed/saveNamed/restoreNamed/removeNamed
// 两者共用同一个主进程存储目录，但语义不同，因此方法名显式区分，不做「一个方法打天下」。

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const sessionClient = {
  // ── 自动会话（单快照）──
  read() {
    return invoke(IPC_ROUTES.sessionRead)
  },
  stats() {
    return invoke(IPC_ROUTES.sessionStats)
  },
  save() {
    return invoke(IPC_ROUTES.sessionSave)
  },
  restore() {
    return invoke(IPC_ROUTES.sessionRestore)
  },
  clear() {
    return invoke(IPC_ROUTES.sessionClear)
  },
  exists() {
    return invoke(IPC_ROUTES.sessionExists)
  },
  // ── 「上次关闭」（启动时归档的上一轮会话，只读副本）──
  /** @returns {Promise<{exists:boolean,savedAt:number,tabs:number,pinned:number,items:Array<{title:string,url:string,favicon:string}>}>} */
  lastClosed() : Promise<{exists:boolean,savedAt:number,tabs:number,pinned:number,items:Array<{title:string,url:string,favicon:string}>}> {
    return invoke(IPC_ROUTES.sessionLastClosed)
  },
  /** 恢复上次关闭的那一份（**追加打开**到当前窗口）@returns {Promise<{restored:boolean,activeTabId?:string|null,trimmed?:boolean}>} */
  restoreLastClosed() : Promise<{restored:boolean,activeTabId?:string|null,trimmed?:boolean}> {
    return invoke(IPC_ROUTES.sessionLastClosedRestore)
  },
  clearLastClosed() {
    return invoke(IPC_ROUTES.sessionLastClosedClear)
  },
  // ── 命名会话（N14）──
  /** @returns {Promise<{ sessions: Array<{id:string,name:string,createdAt:number,tabs:Array<unknown>}> }>} */
  listNamed() : Promise<{ sessions: Array<{id:string,name:string,createdAt:number,tabs:Array<unknown>}> }> {
    return invoke(IPC_ROUTES.sessionNamedList)
  },
  /** 把当前标签集存成一个新快照（同名不覆盖，各自独立）@returns {Promise<{ok:boolean,session?:unknown,reason?:string}>} */
  saveNamed(name: string) : Promise<{ok:boolean,session?:unknown,reason?:string}> {
    return invoke(IPC_ROUTES.sessionNamedSave, { name })
  },
  /** 恢复 = **追加打开**到当前窗口，不替换现有标签 @returns {Promise<{ok:boolean,opened?:number,reason?:string}>} */
  restoreNamed(id: string) : Promise<{ok:boolean,opened?:number,reason?:string}> {
    return invoke(IPC_ROUTES.sessionNamedRestore, { id })
  },
  removeNamed(id: string) {
    return invoke(IPC_ROUTES.sessionNamedRemove, { id })
  }
}


/**
 * Profile 域渲染侧客户端（薄壳）
 *
 * 只做「路由 → invoke」映射，不含状态；状态由编排方持有
 * （profiles 面板在 apps/app-main/src/renderer/panels/main.js 内联编排）。
 */
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

export interface ProfileRecord extends JsonRecord {
  id: string
  name?: string
  icon?: string
  color?: string
  incognito?: boolean
}

function invoke<T = JsonRecord>(route: string, payload?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, payload)
}

export const profilesClient = {
  /** 全部 profile（含 internal/ephemeral） */
  list(): Promise<ProfileRecord[]> {
    return invoke<ProfileRecord[]>(IPC_ROUTES.profileList)
  },
  /** 可见 profile（过滤 internal，供面向用户的列表使用） */
  listVisible(): Promise<ProfileRecord[]> {
    return invoke<ProfileRecord[]>(IPC_ROUTES.profileVisible)
  },
  getActive(): Promise<ProfileRecord | null> {
    return invoke<ProfileRecord | null>(IPC_ROUTES.profileGetActive)
  },
  create({ name, icon, color }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.profileCreate, { name, icon, color })
  },
  /** 新建无痕 profile（internal + ephemeral） */
  createIncognito() {
    return invoke(IPC_ROUTES.profileIncognito)
  },
  update(id: string, patch: JsonRecord) {
    return invoke(IPC_ROUTES.profileUpdate, { id, ...patch })
  },
  /** 切换 profile —— 主进程会连带切换 session / 空间 / 标签会话 */
  setActive(id: string) {
    return invoke(IPC_ROUTES.profileSetActive, { id })
  },
  remove(id: string) {
    return invoke(IPC_ROUTES.profileRemove, { id })
  }
}


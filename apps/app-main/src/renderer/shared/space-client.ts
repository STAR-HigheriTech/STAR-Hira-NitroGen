/**
 * Space 域渲染侧客户端（薄壳）
 *
 * 只做「路由 → invoke」映射，不含任何状态；状态由空间编排层持有
 * （apps/app-main/src/renderer/controllers/space-controller.js）。
 */
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

interface CreateSpaceInput {
  name?: string
  id?: string
  icon?: string
  bgStartColor?: string
  bgEndColor?: string
}

export interface SpaceRecord extends JsonRecord {
  id: string
  profileId: string
  name?: string
  icon?: string
}

function invoke<T = JsonRecord>(route: string, payload?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, payload)
}

export const spaceClient = {
  /** 某个 profile 下的空间列表（按 order 排序） */
  list(profileId: string): Promise<SpaceRecord[]> {
    return invoke<SpaceRecord[]>(IPC_ROUTES.spaceList, { profileId })
  },
  /** 全量空间（跨 profile，internal profile 的空间已被主进程过滤） */
  listAll(): Promise<SpaceRecord[]> {
    return invoke<SpaceRecord[]>(IPC_ROUTES.spaceListAll)
  },
  get(profileId: string, spaceId: string): Promise<SpaceRecord | null> {
    return invoke<SpaceRecord | null>(IPC_ROUTES.spaceGet, { profileId, spaceId })
  },
  create(profileId: string, { name, id, icon, bgStartColor, bgEndColor }: CreateSpaceInput = {}) {
    return invoke(IPC_ROUTES.spaceCreate, { profileId, name, id, icon, bgStartColor, bgEndColor })
  },
  update(profileId: string, spaceId: string, patch: JsonRecord) {
    return invoke(IPC_ROUTES.spaceUpdate, { profileId, spaceId, patch })
  },
  move(profileId: string, spaceId: string, targetProfileId: string) {
    return invoke(IPC_ROUTES.spaceMove, { profileId, spaceId, targetProfileId })
  },
  remove(profileId: string, spaceId: string) {
    return invoke(IPC_ROUTES.spaceRemove, { profileId, spaceId })
  },
  reorder(entries: readonly JsonRecord[]) {
    return invoke(IPC_ROUTES.spaceReorder, { entries })
  },
  /** 切换当前窗口空间（跨 profile 时主进程会连带切换 profile） */
  setUsing(profileId: string, spaceId: string) {
    return invoke(IPC_ROUTES.spaceSetUsing, { profileId, spaceId })
  },
  /** 当前窗口正在使用的空间 */
  getUsing(): Promise<SpaceRecord | null> {
    return invoke<SpaceRecord | null>(IPC_ROUTES.spaceGetUsing)
  },
  getLastUsed(profileId: string) {
    return invoke(IPC_ROUTES.spaceGetLastUsed, { profileId })
  }
}

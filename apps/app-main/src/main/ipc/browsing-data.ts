/**
 * IPC · BrowsingData 域（TypeScript）—— 「立即清除浏览数据」
 *
 * 与设置项 `privacy.clear_*_on_exit` 的分工：设置项是退出时自动清理的长期策略，
 * 本域是用户点一下立刻生效的一次性动作。两者共用同一组类型名，界面词汇统一。
 *
 * 数据来源分两类，因此注入两个端口：
 *   - `getSession()`：Chromium 侧存储（cookie / cache / localStorage / indexedDB …）
 *   - `historyService` / `downloadService`：SQLite 侧的领域数据（历史 / 下载记录）
 *
 * 失败隔离：单个类型清理失败只把该项记为 false，不阻断其它类型 ——
 * 「清了一部分」也好过因缓存目录被占用而整批回滚。
 */

interface SessionLike {
  clearCache(): Promise<void>
  clearStorageData(options: { storages: string[]; origin?: string }): Promise<void>
}

interface HistoryLike {
  clearAll(): number | Promise<number>
  removeAfter(afterTs: number): number | Promise<number>
  removeBefore?(beforeTs: number): number | Promise<number>
}

interface DownloadLike {
  clearAll(): number | Promise<number>
  removeAfter?(afterTs: number): number | Promise<number>
}

import { errorMessage, type IpcSchemas, type IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['browsingData']
  getSession?: () => SessionLike | null
  historyService?: HistoryLike | null
  downloadService?: DownloadLike | null
}

/**
 * 浏览数据类型 → Electron `clearStorageData` 的 storages 桶。
 * 'siteData' 是「其余站点存储」的汇总项：覆盖 Chromium 的全部站点级桶（含 cookies），
 * 与界面上「站点数据（含 Cookie）」的说明保持一致。
 */
export const STORAGE_BUCKETS: Record<string, string[]> = {
  cookies: ['cookies'],
  localStorage: ['localstorage'],
  indexedDB: ['indexdb'],
  serviceWorkers: ['serviceworkers'],
  cacheStorage: ['cachestorage'],
  siteData: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage', 'appcache', 'shadercache']
}

export function registerBrowsingDataIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getSession, historyService, downloadService }: Deps
): void {
  if (!routes?.browsingDataClear || !schemas?.clear) return

  typedMain.handle(routes.browsingDataClear, {
    requestSchema: schemas.clear.request,
    responseSchema: schemas.clear.response,
    handler: async (_e, req) => clearBrowsingData({ getSession, historyService, downloadService }, req)
  })
}

/**
 * 「立即清除浏览数据」的**唯一实现** —— IPC 路由与 AI 工具（`browsing_data_clear`）共用。
 *
 * 规则只能有一份：哪些类型支持按站点清、`since` 是哪种下界、失败如何逐项隔离，
 * 复制到 AI 侧必然会漂移，最终表现为「页面上清得干净、AI 清的少了一项」。
 *
 * @param deps 与注册器相同的三个端口（会话 / 历史 / 下载）
 * @param req  types 必填；since 是「只清最近」的下界（毫秒）；origin 仅对存储桶生效
 */
export async function clearBrowsingData(
  { getSession, historyService, downloadService }: Deps,
  req: { types: string[]; since?: number; origin?: string }
): Promise<{ ok: boolean; results: Record<string, boolean>; errors?: Record<string, string> }> {
  const types = Array.isArray(req.types) ? req.types : []
  const since = typeof req.since === 'number' ? req.since : undefined
  // 站点级清理：只对 storage 桶生效（Chromium 的 clearStorageData 支持 origin）。
  // history / downloads / cache 没有「某个站点」的语义 —— 传了 origin 就拒绝执行，
  // 免得「清除本站数据」误把全局缓存/历史一起清掉。
  const origin = typeof req.origin === 'string' && req.origin ? req.origin : undefined
  const session = getSession ? getSession() : null
  const results: Record<string, boolean> = {}
  const errors: Record<string, string> = {}

  for (const type of types) {
    try {
      if (origin && (type === 'history' || type === 'downloads' || type === 'cache')) {
        results[type] = false
        errors[type] = '该类型不支持按站点范围清理'
        continue
      }
      if (type === 'history') {
        if (!historyService) { results[type] = false; errors[type] = '历史服务不可用'; continue }
        // since = 「只清最近 N」的下界；缺省表示全部清空。
        if (since !== undefined) await historyService.removeAfter(since)
        else await historyService.clearAll()
        results[type] = true
      } else if (type === 'downloads') {
        if (!downloadService) { results[type] = false; errors[type] = '下载服务不可用'; continue }
        if (since !== undefined && typeof downloadService.removeAfter === 'function') {
          await downloadService.removeAfter(since)
        } else {
          await downloadService.clearAll()
        }
        results[type] = true
      } else if (type === 'cache') {
        if (!session) { results[type] = false; errors[type] = '会话不可用'; continue }
        await session.clearCache()
        results[type] = true
      } else {
        const buckets = STORAGE_BUCKETS[type]
        if (!session || !buckets) { results[type] = false; errors[type] = '不支持的存储类型'; continue }
        await session.clearStorageData(origin ? { storages: buckets, origin } : { storages: buckets })
        results[type] = true
      }
    } catch (error) {
      const message = errorMessage(error)
      console.error(`[browsing-data] clear ${type} failed:`, message)
      results[type] = false
      errors[type] = message
    }
  }

  return {
ok: Object.values(results).every(Boolean),
results,
errors: Object.keys(errors).length > 0 ? errors : undefined
  }
}


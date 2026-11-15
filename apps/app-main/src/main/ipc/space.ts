/**
 * IPC · Space 域（工作空间）
 *
 * 对齐 RT `src/main/ipc/session/spaces.ts`：
 *   - 读：list / listAll / get / getUsing / getLastUsed
 *   - 写：create / update / remove / reorder / setUsing
 *   - 写操作后广播 `space:changed`（RT `fireOnSpacesChanged`），
 *     `setUsing` 额外向本窗口推 `space:window-changed`（RT `spaces:on-set-window-space`）
 *
 * 依赖全部注入（spaceService / switchSpace / profileService），本文件不 require 任何域实现。
 */

import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import type { SpaceChangeNotifier } from './space-events'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface ProfileServicePort { isInternalId(profileId: unknown): boolean }
interface SpaceIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['space']
  spaceService: MethodPort
  switchSpace?: (spaceId: string, profileId: string) => unknown
  getUsingSpace?: () => unknown
  profileService?: ProfileServicePort | null
  emitToWindow?: (route: string, payload: unknown) => unknown
  destroySpaceTabs?: (profileId: string, spaceId: string) => unknown
  events?: { spaceWindowChanged?: string }
  providerRegistry?: ProviderRegistryPort | null
  notifySpaceChanged?: SpaceChangeNotifier
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function asSpace(value: Record<string, unknown>): { id: unknown; profileId: unknown } {
  return { id: value.id ?? null, profileId: value.profileId ?? null }
}

/**
 * @param {object} typedMain
 * @param {object} deps
 * @param {object} deps.routes   IPC_ROUTES
 * @param {object} deps.schemas  ipcSchemas.space
 * @param {object} deps.spaceService
 * @param {(spaceId: string, profileId: string) => Promise<any>} [deps.switchSpace]
 * @param {() => object|null} [deps.getUsingSpace] 当前窗口正在使用的空间（APPS 层持有运行态）
 * @param {object} [deps.profileService]
 * @param {(profileId: string, spaceId: string) => object} [deps.destroySpaceTabs]
 * @param {object} [deps.events] IPC_EVENTS
 * @param {object} [deps.providerRegistry]
 * @param {(reason: string, space: any) => void} [deps.notifySpaceChanged]
 *   空间列表变更的唯一出口（`ipc/space-events.js`）：CRUD 与归档导入共用，
 *   内部负责 `onSpacesChanged()`（原生菜单重建）+ 应用级 `space:changed` 广播。
 * @param {(route:string, payload:any) => number} [deps.emitToWindow] **窗口级**事件出口：
 *   只发给「发起本次 IPC 的那个窗口」。「本窗口当前空间变了」（space:window-changed）
 *   是窗口级事实 → 必须用 emitToWindow，否则 B 窗口切空间会让 A 窗口的
 *   切换器/列表跟着跳（多窗口串台）。
 */
export function registerSpaceIpc(typedMain: IpcTypedMain, {
  routes,
  schemas,
  spaceService,
  switchSpace,
  getUsingSpace,
  profileService,
  emitToWindow,
  destroySpaceTabs,
  events,
  providerRegistry,
  notifySpaceChanged
}: SpaceIpcContext): void {
  if (!spaceService) return
  const invoke = createProviderInvoker(providerRegistry)

  /** 变更广播：统一走注入的出口（空实现兜底，保证两条路径都只是"不广播"而非报错）。 */
  const notifyChanged = typeof notifySpaceChanged === 'function'
    ? notifySpaceChanged
    : () => {}

  /** 向该空间所属 profile 是否 internal —— internal 空间不外露。 */
  function isInternalProfile(profileId: string): boolean {
    if (!profileService) return false
    try { return !!profileService.isInternalId(profileId) } catch { return false }
  }

  typedMain.handle(routes.spaceList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => invoke('space.list', () => spaceService.list(req.profileId), req)
  })

  typedMain.handle(routes.spaceListAll, {
    requestSchema: schemas.listAll.request,
    responseSchema: schemas.listAll.response,
    /**
     * 「internal profile 的空间不外露」这个**过滤**也必须留在 handler 里 —— 它与
     * `notifyChanged` 是同一类东西：写进 fallback 就只在"没有 provider"时才生效。
     * `space-service` 一旦上线，兜底不再执行，internal 空间就会漏进列表
     * （而它本不该被用户看到）。判定依赖 `profileService.isInternalId`，那也属 APPS 关注点。
     */
    handler: async () => {
      const list = await invoke('space.listAll', () => spaceService.listAll(), null)
      return Array.isArray(list) ? list.filter((s) => !isInternalProfile(s.profileId)) : list
    }
  })

  typedMain.handle(routes.spaceGet, {
    requestSchema: schemas.get.request,
    responseSchema: schemas.get.response,
    handler: async (_e, req) => invoke('space.get', () => spaceService.get(req.profileId, req.spaceId), req)
  })

  /**
   * ── 写路径的编排为什么**不能**留在 fallback 闭包里 ──────────────────
   *
   * `invoke(capability, fallback)` 的第二个参数是「**没有 provider 时**才跑」的分支。
   * 这些 handler 原来把 `notifyChanged` / `destroySpaceTabs` 写在 fallback 里 ——
   * 在没有 `space-service` 插件的年代它总能跑到（永远走兜底），所以看不出问题。
   * 一旦插件开始提供 provider，fallback 就不再执行，于是**广播静默消失**：
   * 建/删/改空间后界面不再刷新，且没有任何报错。
   *
   * 因此编排一律提到 handler 里、在 provider 调用**之后**执行 ——
   * 这样"有 provider"与"无 provider（降级）"两条路径都会跑到。
   * 这也是"域服务插件化"这一类改动最容易踩的坑：**只搬实现、不搬副作用**。
   */
  typedMain.handle(routes.spaceCreate, {
    requestSchema: schemas.create.request,
    responseSchema: schemas.create.response,
    handler: async (_e, req) => {
      const res = asRecord(await invoke('space.create', () => spaceService.create(req.profileId, {
        id: req.id,
        name: req.name,
        icon: req.icon,
        bgStartColor: req.bgStartColor,
        bgEndColor: req.bgEndColor
      }), req))
      if (res.ok) notifyChanged('created', asSpace(asRecord(res.space)))
      return res
    }
  })

  typedMain.handle(routes.spaceUpdate, {
    requestSchema: schemas.update.request,
    responseSchema: schemas.update.response,
    handler: async (_e, req) => {
      const space = asRecord(await invoke('space.update', () => spaceService.update(req.profileId, req.spaceId, req.patch), req))
      if (Object.keys(space).length) notifyChanged('updated', asSpace(space))
      return space
    }
  })

  typedMain.handle(routes.spaceMove, {
    requestSchema: schemas.move.request,
    responseSchema: schemas.move.response,
    handler: async (_e, req) => {
      const space = asRecord(await invoke('space.move', () => spaceService.move(req.profileId, req.spaceId, req.targetProfileId), req))
      if (Object.keys(space).length) notifyChanged('moved', asSpace(space))
      return space
    }
  })

  typedMain.handle(routes.spaceRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => {
      const ok = await invoke('space.remove', () => spaceService.remove(req.profileId, req.spaceId), req)
      if (ok) {
        // 删空间的**收尾**（销毁该空间的标签）与广播同属编排，一并提出来
        if (typeof destroySpaceTabs === 'function') destroySpaceTabs(req.profileId, req.spaceId)
        notifyChanged('deleted', { id: req.spaceId, profileId: req.profileId })
      }
      return { ok }
    }
  })

  typedMain.handle(routes.spaceReorder, {
    requestSchema: schemas.reorder.request,
    responseSchema: schemas.reorder.response,
    handler: async (_e, req) => {
      const ok = await invoke('space.reorder', () => { spaceService.reorder(req.entries); return true }, req)
      if (ok) notifyChanged('reordered', null)
      return { ok }
    }
  })

  typedMain.handle(routes.spaceGetUsing, {
    requestSchema: schemas.getUsing.request,
    responseSchema: schemas.getUsing.response,
    // `getUsingSpace` 是**窗口级**运行态（"本窗口在用哪个空间"），属"这次调用的数据"，
    // 因此经 invoke 的 context 传给实现 —— 插件自己查不到它（它不知道是谁在问）。
    handler: async () => invoke('space.getUsing', () => (
      typeof getUsingSpace === 'function' ? getUsingSpace() : null
    ), null, { getUsingSpace })
  })

  typedMain.handle(routes.spaceGetLastUsed, {
    requestSchema: schemas.getLastUsed.request,
    responseSchema: schemas.getLastUsed.response,
    handler: async (_e, req) => invoke('space.getLastUsed', () => spaceService.getLastUsed(req.profileId), req)
  })

  typedMain.handle(routes.spaceSetUsing, {
    requestSchema: schemas.setUsing.request,
    responseSchema: schemas.setUsing.response,
    /**
     * 三步，**顺序与归属都不能动**：
     *   1. provider/兜底做"校验 + 快照"（`space.setUsing` → `{ ok, space }`）；
     *   2. **编排**（保存会话 / 关标签 / 换 session / 恢复）—— 在 APPS 层，
     *      与 RT 的 `setUsingSpace(window, profileId, spaceId)` 同构，域层不碰 tab 生命周期；
     *   3. 窗口级推送 + 重新读一份切换后的空间返回。
     *
     * 第 2、3 步此前也写在 fallback 闭包里（见上面写路径的说明）—— 同样提出来，
     * 否则 `space-service` 一上线，「切空间不生效/不广播」会立刻出现且毫无报错。
     */
    handler: async (_e, req) => {
      const res = asRecord(await invoke('space.setUsing', () => {
        const space = spaceService.get(req.profileId, req.spaceId)
        return space ? { ok: true, space } : { ok: false, space: null }
      }, req))
      const space = asRecord(res.space)
      if (!res || res.ok !== true || !space) return { ok: false, space: null }

      if (typeof switchSpace === 'function') {
        await switchSpace(req.spaceId, req.profileId)
      } else {
        spaceService.setLastUsed(req.profileId, req.spaceId)
      }
      // 「本窗口当前空间」是窗口级事实：只推给发起它的那个窗口（见 deps.emitToWindow 说明）。
      // 解析不到发起窗口时 emitToWindow 会告警并丢弃 —— 绝不广播给所有窗口。
      if (typeof emitToWindow === 'function') {
        try {
          emitToWindow(events && events.spaceWindowChanged ? events.spaceWindowChanged : 'space:window-changed', {
            spaceId: space.id,
            profileId: space.profileId
          })
        } catch {}
      }
      // 切换编排可能改动了空间（lastUsed 等）→ 返回切换后的那一份
      return { ok: true, space: spaceService.get(req.profileId, req.spaceId) }
    }
  })
}


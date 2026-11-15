/**
 * IPC · Profile 域（W21）—— 自 ipc-routes.js 原样搬入（Step 5，语义零改动）。
 */

import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { createProviderInvoker } = require('./provider-bridge.js') as {
  createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown, context?: unknown) => T | Promise<T>
}

interface ProfileRecord { id?: unknown }
interface ProfileServicePort {
  list(): unknown
  getActive(): ProfileRecord | null | undefined
  create(input: { name: unknown; icon: unknown; color: unknown }): unknown
  update(id: unknown, input: { name: unknown; icon: unknown; color: unknown }): unknown
  setActive(id: unknown): unknown
  remove(id: unknown): unknown
  createIncognito(): unknown
  listVisible(): unknown
}

interface ProfileIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['profile']
  profileService?: ProfileServicePort | null
  switchProfile?: (id: unknown) => unknown
  onProfileRemoved?: (id: string) => void
  providerRegistry: unknown
}

export function registerProfileIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, profileService, switchProfile, onProfileRemoved, providerRegistry }: ProfileIpcContext
): void {
  if (!profileService) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.profileList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => invoke('profile.list', () => profileService.list(), null)
  })

  typedMain.handle(routes.profileGetActive, {
    requestSchema: schemas.getActive.request,
    responseSchema: schemas.getActive.response,
    handler: async () => invoke('profile.getActive', () => profileService.getActive(), null)
  })

  typedMain.handle(routes.profileCreate, {
    requestSchema: schemas.create.request,
    responseSchema: schemas.create.response,
    handler: async (_e, req) => invoke('profile.create', () => profileService.create({ name: req.name, icon: req.icon, color: req.color }), req)
  })

  typedMain.handle(routes.profileUpdate, {
    requestSchema: schemas.update.request,
    responseSchema: schemas.update.response,
    handler: async (_e, req) => invoke('profile.update', () => profileService.update(req.id, { name: req.name, icon: req.icon, color: req.color }), req)
  })

  typedMain.handle(routes.profileSetActive, {
    requestSchema: schemas.setActive.request,
    responseSchema: schemas.setActive.response,
    handler: async (_e, req) => invoke('profile.setActive', () => (
      // 切换编排（保存会话 / 关标签 / 换 session / 恢复）在 APPS 层：
      // 只落 DB 不切 session，会留下「标签还是旧 profile 那套」的半成品状态。
      typeof switchProfile === 'function' ? switchProfile(req.id) : profileService.setActive(req.id)
    ), req, { switchProfile })
  })

  typedMain.handle(routes.profileRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => {
      const wasActive = (profileService.getActive()?.id || '') === req.id
      const ok = await invoke('profile.remove', () => profileService.remove(req.id), req)
      // 删掉的正是运行中的 profile → 运行态（session / 扩展 / 空间）必须跟着落到新的 active，
      // 否则会停在「DB 里没有、内存里还在用」的幽灵 profile 上。
      if (ok && wasActive && typeof switchProfile === 'function') {
        try { await switchProfile(profileService.getActive()?.id || 'default') } catch (e) {
          console.error('[profile:remove] follow-up switch failed:', e instanceof Error ? e.message : String(e))
        }
      }
      if (ok && typeof onProfileRemoved === 'function') {
        try { onProfileRemoved(req.id) } catch (e) {
          console.error('[profile:remove] runtime cleanup failed:', e instanceof Error ? e.message : String(e))
        }
      }
      return { ok }
    }
  })

  // ── 对齐 RT profiles-controller 的增量能力 ──
  if (routes.profileIncognito) {
    typedMain.handle(routes.profileIncognito, {
      requestSchema: schemas.incognito.request,
      responseSchema: schemas.incognito.response,
      handler: async () => invoke('profile.createIncognito', () => profileService.createIncognito(), null)
    })
  }

  if (routes.profileVisible) {
    typedMain.handle(routes.profileVisible, {
      requestSchema: schemas.visible.request,
      responseSchema: schemas.visible.response,
      handler: async () => invoke('profile.listVisible', () => profileService.listVisible(), null)
    })
  }
}


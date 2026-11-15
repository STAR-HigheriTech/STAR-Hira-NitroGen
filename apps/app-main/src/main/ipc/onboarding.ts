import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface OnboardingService {
  getState(): unknown
  complete(): unknown | Promise<unknown>
  reset(): unknown | Promise<unknown>
}

interface OnboardingIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['onboarding']
  onboarding?: OnboardingService | null
}

/**
 * ipc/onboarding.js — OOBE 首次启动引导域路由（自包含）
 *
 * 三条通道，全部是「薄转发」：真正的状态与动作只有一份，在
 * `main/onboarding/index.js` 的控制器里。这里不判断版本、不认识窗口，
 * 只把渲染层的意图转给控制器 —— 否则「是否已完成」会出现第二套判定。
 *
 * ── 为什么 complete 不抛异常 ────────────────────────────────────
 * 引导页的「完成」是**出口动作**：IPC 抛异常会让页面卡在末阶段，用户既走不掉
 * 也看不懂。控制器内部已做幂等，这里统一降级为 `{ ok:false }` 由页面提示重试。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, onboarding:any }} ctx
 */
export function registerOnboardingIpc(typedMain: IpcTypedMain, ctx: OnboardingIpcContext): void {
  const { routes, schemas, onboarding } = ctx || {}
  if (!typedMain || !routes || !schemas || !schemas.state) return
  if (!onboarding || typeof onboarding.getState !== 'function') return

  typedMain.handle(routes.onboardingState, {
    requestSchema: schemas.state.request,
    responseSchema: schemas.state.response,
    handler: async () => onboarding.getState()
  })

  typedMain.handle(routes.onboardingComplete, {
    requestSchema: schemas.complete.request,
    responseSchema: schemas.complete.response,
    handler: async () => {
      try {
        return await onboarding.complete()
      } catch (e) {
        console.error('[onboarding] 完成引导失败:', e instanceof Error ? e.message : String(e))
        return { ok: false }
      }
    }
  })

  typedMain.handle(routes.onboardingReset, {
    requestSchema: schemas.reset.request,
    responseSchema: schemas.reset.response,
    handler: async () => {
      try {
        return await onboarding.reset()
      } catch (e) {
        console.error('[onboarding] 重置引导失败:', e instanceof Error ? e.message : String(e))
        return { ok: false }
      }
    }
  })
}


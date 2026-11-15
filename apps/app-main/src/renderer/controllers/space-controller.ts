/**
 * 空间编排层（controller）—— 只管**数据**，不管任何 UI 的开合。
 *
 * 职责：把 domain-space 的数据 → 喂给哑组件（navbar 的空间胶囊），
 * 并在空间事实变化时重拉。对齐 RT `spaces-provider` 的选择优先级：
 *   preferred → 当前窗口空间（getUsing）→ 上次使用（getLastUsed）→ 第一个空间
 * internal profile 的空间由主进程过滤，渲染层不再重复判断。
 *
 * ── 为什么这里**没有**菜单开合状态 ─────────────────────────────────────
 * 空间胶囊点开后弹出的「总览」浮层（`renderer/overview-overlay`）是**独立视图**，
 * 它自己拉数据、自己订阅、自己判定收起 —— 开合真源在那一侧，本文件不复制一份，
 * 也就不会出现"外壳以为还开着、浮层其实已经收了"的双份状态。
 * 本文件与那颗胶囊同生共死：只回答「当前是哪个空间」。
 */
import { spaceClient, type SpaceRecord } from '../shared/space-client.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'

interface SpaceControllerOptions {
  view: { setSpaces(spaces: SpaceRecord[], activeId: string, profileId: string): void }
  onSubscribe(route: string, listener: (payload: unknown) => void): () => void
}
export interface SpaceController {
  start(): Promise<void>
  refresh(preferred?: { id?: string; profileId?: string } | string): Promise<void>
  dispose(): void
  getCurrent(): { id: string; profileId: string } | null
}

/**
 * @param {{
 *   view: { setSpaces: Function },
 *   onSubscribe: (route: string, cb: (payload: unknown) => void) => (() => void)
 * }} deps
 */
export function createSpaceController({ view, onSubscribe }: SpaceControllerOptions): SpaceController {
  let disposed = false
  const disposers: Array<() => void> = []

  /** 当前窗口运行态：{ id, profileId }。由主进程权威提供，渲染层只缓存。 */
  let current: { id: string; profileId: string } | null = null
  let cachedSpaces: SpaceRecord[] = []
  let queued = false
  let flushing: Promise<void> | null = null
  let pendingPreferred: { id: string; profileId: string } | null = null

  function setView(list: SpaceRecord[], space: SpaceRecord | null, profileId: string): void {
    if (!view || typeof view.setSpaces !== 'function') return
    view.setSpaces(list || [], space ? space.id : '', profileId || (space ? space.profileId : ''))
  }

  /**
   * 拉全量空间 + 当前窗口空间，按优先级选出 active。
   *
   * `preferred` 必须同时带 profileId：不同 profile 可以拥有同名空间（最常见的就是
   * 每个 profile 都有 `default`），只按 id 匹配会让跨 profile 切换后的胶囊显示
   * 到另一个 profile 的那一行。并发刷新采用「最后一帧赢」：请求期间又来了更新的
   * 切换，就丢弃旧结果并在同一轮继续拉最新事实，不让迟到响应把 UI 推回旧状态。
   */
  function refresh(preferred?: { id?: string; profileId?: string } | string): Promise<void> {
    if (disposed) return Promise.resolve()
    if (preferred) {
      pendingPreferred = typeof preferred === 'string'
        ? { id: preferred, profileId: '' }
        : { id: String(preferred.id || ''), profileId: String(preferred.profileId || '') }
    }
    if (queued && flushing) return flushing
    queued = true
    flushing = Promise.resolve().then(async () => {
      try {
        while (!disposed) {
          const preferredNext = pendingPreferred
          pendingPreferred = null
          const [all, using] = await Promise.all([
            spaceClient.listAll(),
            spaceClient.getUsing().catch(() => null)
          ])
          if (disposed) return
          // 拉取期间又有更明确的落点：这一份已经过时，直接重拉，不把旧 active 画上屏。
          if (pendingPreferred) continue
          const spaces = Array.isArray(all) ? all : []
          cachedSpaces = spaces

          let active: SpaceRecord | null = null
          if (preferredNext && preferredNext.id) {
            active = spaces.find((s) => s.id === preferredNext.id
              && (!preferredNext.profileId || s.profileId === preferredNext.profileId)) || null
          }
          if (!active && using) {
            active = spaces.find((s) => s.id === using.id && s.profileId === using.profileId) || using
          }
          if (!active) active = spaces.find((s) => s.id === current?.id && s.profileId === current?.profileId) || null
          if (!active) active = spaces[0] || null

          current = active ? { id: active.id, profileId: active.profileId } : null
          setView(spaces, active, active ? active.profileId : '')
          break
        }
      } catch (e) {
        console.error('[space-controller] refresh failed:', e)
      } finally {
        queued = false
        flushing = null
        // 边界情况：finally 前刚好又来了一次请求，不能让这次更新卡在队列里。
        if (pendingPreferred && !disposed) void refresh()
      }
    })
    return flushing
  }

  function start() {
    if (typeof onSubscribe === 'function') {
      // 任何来源的空间变更（管理页 / 总览浮层 / 其他窗口）都重拉一次。
      disposers.push(onSubscribe(IPC_EVENTS.spaceChanged, () => { refresh().catch(() => {}) }))
      disposers.push(onSubscribe(IPC_EVENTS.spaceWindowChanged, (rawPayload) => {
        const payload = rawPayload !== null && typeof rawPayload === 'object'
          ? rawPayload as Record<string, unknown>
          : null
        if (typeof payload?.spaceId === 'string' && payload.spaceId) {
          refresh({
            id: payload.spaceId,
            profileId: typeof payload.profileId === 'string' ? payload.profileId : ''
          }).catch(() => {})
        }
      }))
      // profile 切换不一定经过 space:window-changed（用户可能是在 profile 页直接切）。
      // 此处统一让所有持有本控制器的面（外壳 / 独立侧栏）重读窗口级事实。
      disposers.push(onSubscribe(IPC_EVENTS.profileChanged, (rawPayload) => {
        const payload = rawPayload !== null && typeof rawPayload === 'object'
          ? rawPayload as Record<string, unknown>
          : null
        refresh(payload && typeof payload.spaceId === 'string'
          ? { id: payload.spaceId, profileId: typeof payload.profileId === 'string' ? payload.profileId : '' }
          : undefined).catch(() => {})
      }))
    }
    return refresh()
  }

  function dispose() {
    disposed = true
    while (disposers.length) {
      try { disposers.pop()?.() } catch {}
    }
  }

  return {
    start,
    refresh,
    dispose,
    getCurrent: () => current
  }
}


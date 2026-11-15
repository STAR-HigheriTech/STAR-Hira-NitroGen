export interface SpaceChangeNotifierDependencies {
  emit?: (channel: string, payload: unknown) => number | void
  events?: { spaceChanged?: string }
  onSpacesChanged?: () => void
}

export interface SpaceLike { id: unknown; profileId: unknown }

export type SpaceChangeNotifier = (reason: string, space?: SpaceLike | null) => void

/**
 * Space 变更广播 —— 写路径的**唯一副作用出口**。
 *
 * 为什么单独成文件：`ipc/space.js`（CRUD / 重排 / 切换）与 `ipc/space-archive.js`
 * （导入）都会改动空间列表，两边都必须在**写成功之后**做同样两件事：
 *   ① 让宿主重建原生菜单（「空间」子菜单不能停留在旧列表）；
 *   ② 向所有 renderer 广播 `space:changed`（页面据此重拉列表）。
 * 抄两份必然漂移 —— 尤其"广播只在没有 provider 时发生"这类事故（见 ipc/space.js
 * 里写路径的说明）。因此把这段编排收敛在这里，注册器只拿到一个 `notify(reason, space)`。
 */

/**
 * @param {{
 *   emit?: (channel: string, payload: any) => number|void,
 *   events?: object,
 *   onSpacesChanged?: () => void
 * }} deps
 * @returns {(reason: string, space?: any) => void}
 */
export function createSpaceChangeNotifier({ emit, events, onSpacesChanged }: SpaceChangeNotifierDependencies = {}): SpaceChangeNotifier {
  return function notifySpaceChanged(reason: string, space?: SpaceLike | null): void {
    if (typeof onSpacesChanged === 'function') {
      try { onSpacesChanged() } catch (_) {}
    }
    if (typeof emit !== 'function') return
    try {
      emit(events && events.spaceChanged ? events.spaceChanged : 'space:changed', {
        reason,
        spaceId: space ? space.id : null,
        profileId: space ? space.profileId : null
      })
    } catch {}
  }
}


/**
 * IPC · Tab Snapshot 域（TypeScript）
 *
 * 渲染层询问「某标签当前截图的读取 URL」，拿回来后把 <img src> 指过去即可
 * （URL 形如 hira://tab-snapshot?id=…，由主进程内存直接吐出 JPEG）。
 *
 * 与采集/存储解耦：采集编码在 TabSnapshotService，内存淘汰在 SnapshotStore，
 * 本文件只做 typed 路由 → service.urlFor 的映射，不含任何 electron / 位图逻辑。
 *
 * 本文件是 NG 的第一批 TypeScript 模块：构建侧由 electron.vite.config.js 的
 * copy-main-sources 插件用 esbuild 就地转译为 out/main/ipc/snapshot.js，
 * 因此 `require('./ipc/snapshot')` 的调用点零改动。
 */

/** 本域只依赖注入的抽象，不 import electron —— 便于在无 Electron 环境下单测。 */
interface SnapshotService {
  urlFor(tabId: string): string | null
}

import type { IpcSchemas, IpcTypedMain } from './types'

interface Routes {
  tabSnapshot?: string
}

/**
 * ⚠ 契约形状：`snapshotSchemas` 是**扁平**的 `{ request, response }`（见
 * infra-ipc/src/contracts/snapshot.js），调用方传进来的就是它本身，
 * **不是** `{ snapshot: { request, response } }`。
 *
 * 这里曾经写成 `schemas.snapshot.request` —— 于是 `schemas.snapshot` 恒为 undefined，
 * 早退发生、`tab:snapshot` 处理器**从未注册**，渲染层的 hover 预览永远拿不到截图
 * （只能回退 favicon），而日志里只有一句 "No handler registered"。
 * 契约形状改动时务必同步这里：静默早退比报错更难发现。
 */
interface Deps {
  routes?: Routes
  schemas?: IpcSchemas['snapshot']
  snapshotService?: SnapshotService | null
}

export function registerSnapshotIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, snapshotService }: Deps
): void {
  if (!routes?.tabSnapshot || !snapshotService) return
  if (!schemas?.request || !schemas?.response) {
    // 显式告警而不是静默早退：这条通道断了会表现为「hover 预览没图」，
    // 与「本来就没采到帧」极难区分，必须有日志可查。
    console.error('[snapshot] registerSnapshotIpc skipped: schemas.request/response missing')
    return
  }

  typedMain.handle(routes.tabSnapshot, {
    requestSchema: schemas.request,
    responseSchema: schemas.response,
    handler: async (_e, req) => ({ url: snapshotService.urlFor(req.tabId) })
  })
}


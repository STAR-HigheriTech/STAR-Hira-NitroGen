/**
 * external-games/index.ts — 外部静态 bundle（游戏）特性模块唯一入口
 *
 * 与 settings/ 同构：一个横切特性收拢成一个自包含目录，只通过少数明确接口对外。
 *
 *   registerAppSchemes()                            ← app.ready **之前**调用（特权协议注册，
 *                                                     见 main/scheme-privileges.js）
 *   createExternalGamesFeature({ session })         ← app.ready **之后**调用（挂协议 + 建目录）
 *   registerExternalGamesIpc(typedMain, ctx)        ← 挂 IPC 路由（在 ipc-routes.js 装配）
 *
 * 目录布局：
 *   catalog.ts    自描述 bundle 扫描 → 游戏目录（插件点：丢目录即新增游戏）
 *   protocol.ts   hira-game:// 只读静态协议
 *   ipc.ts        game:list 路由
 *
 * 外部只 require 本文件，不直接依赖内部文件。
 */

import type { Session } from 'electron'
import {
  GAME_SCHEME,
  createGameCatalog,
  normalizeGame,
  resolveGamesRoot,
  type GameCatalog
} from './catalog'
import { createGameProtocolHandler, registerGameProtocol } from './protocol'
import { registerExternalGamesIpc } from './ipc'

interface ExternalGamesFeatureOptions {
  session?: Session
  dir?: string
  root?: string
}

interface ExternalGamesFeature {
  catalog: GameCatalog
  scheme: string
  registerOn(session?: Session): void
}

/**
 * 建目录 + 挂协议（默认 session）。
 * tags 使用的 tab session 是分区 session，别忘用返回的 registerOn() 补挂。
 */
export function createExternalGamesFeature (opts: ExternalGamesFeatureOptions = {}): ExternalGamesFeature {
  const catalog = createGameCatalog({ root: opts.root, dir: opts.dir })
  registerGameProtocol(opts.session, catalog)
  // 后台预热：把同步扫盘从交互热路挪到启动静默阶段，首次打开游戏页即可命中缓存
  catalog.prewarm()
  catalog.list().then((games) => {
    console.log(`[external-games] ready · scheme=${GAME_SCHEME} · bundles=${games.length} · root=${catalog.root}`)
  }).catch(() => {
    console.log(`[external-games] ready · scheme=${GAME_SCHEME} · root=${catalog.root}`)
  })
  return {
    catalog,
    scheme: GAME_SCHEME,
    /** 把协议挂到指定 session（如 tab 实际使用的扩展分区 session）。 */
    registerOn (session?: Session) {
      if (session) registerGameProtocol(session, catalog)
    }
  }
}

export {
  // 特性入口
  registerExternalGamesIpc,
  // 构件（供测试 / 高级用法）
  createGameCatalog,
  createGameProtocolHandler,
  resolveGamesRoot,
  normalizeGame,
  GAME_SCHEME
}

/**
 * external-games/protocol.ts — hira-game:// 协议
 *
 * 只做一件事：把 hira-game://<bundle-id>/<path> 映射到
 *   out/external/games/<bundle-id>/<path>
 * 的**只读静态文件**。
 *
 * 为什么单独一个协议（而不是塞进 hira://）？
 *  1. 来源不同：hira:// 放的是我们自己的内部页（settings/history…），
 *     hira-game:// 放的是**第三方静态 bundle**（恐龙、冲浪，来自上游仓库）。
 *  2. 权限边界：标签页的 preload 会暴露 window.hira IPC 桥。第三方游戏代码
 *     不应拿到我们主进程的 domain 路由（history/download/settings…）。
 *     独立 scheme 让 preload 能按协议名一刀切地不注入桥（见 tab-preload.js）。
 *  3. 解耦：本协议不认识「页面注册中心」，只认识「bundle 目录」，
 *     与 hira-protocol.js 零耦合（共用 static-serve.js 原语）。
 *
 * 安全：host 必须命中 catalog 中已登记的 bundle，否则 404。
 * 因此即便协议是 standard+secure，也无法借它读取任意目录。
 */

import path from 'node:path'
import type { Session } from 'electron'
import { GAME_SCHEME, type GameCatalog } from './catalog'

const { protocol } = require('electron')
const { serveStaticAsync } = require('../static-serve') as {
  serveStaticAsync(baseDir: string, pathname: string, options?: { label?: string }): Promise<Response | null>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 特权注册不在这里 —— 见 `../scheme-privileges.js`（全库唯一一次
// `registerSchemesAsPrivileged`；分散调用会互相覆盖）。

function notFound (id: string): Response {
  const body = `<!doctype html><meta charset="utf-8">
<title>Game not found</title>
<style>body{font-family:"Segoe UI Variable Text","Segoe UI Variable","Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,-apple-system,sans-serif;padding:24px;background:#f0f3f7;color:#1a1a1a}p{color:#666}</style>
<h1>未安装的游戏 bundle</h1><p>hira-game://${id}/ 没有对应的目录（external/games/${id}/）。</p>`
  return new Response(body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/**
 */
export function createGameProtocolHandler (catalog: GameCatalog): (request: Request) => Promise<Response> {
  return async function handleGameRequest (request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const id = url.hostname.toLowerCase()
      // 只服务已登记的 bundle：未登记的 host 一律 404（异步等缓存就绪，避免预热未完误杀）
      if (!(await catalog.getAsync(id))) return notFound(id)
      const resp = await serveStaticAsync(path.join(catalog.root, id), url.pathname, { label: GAME_SCHEME })
      return resp || notFound(id)
    } catch (e) {
      console.error(`[${GAME_SCHEME}] handler error:`, errorMessage(e))
      return new Response('Bad request', { status: 400 })
    }
  }
}

/**
 * 挂载协议处理器（app.ready 之后调用）。
 */
export function registerGameProtocol (session: Session | undefined, catalog: GameCatalog): void {
  const target = session ? session.protocol : protocol
  target.handle(GAME_SCHEME, createGameProtocolHandler(catalog))
}


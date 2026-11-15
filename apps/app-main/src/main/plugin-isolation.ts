'use strict'

/**
 * plugin-isolation.js —— 「插件进程级隔离」这个**端口**的实现（APPS 侧组合根）
 *
 * ── 它在整条链路上的位置 ──────────────────────────────────────────
 *   PluginRegistryV2 里预留着一个注入点：`options.loader`。
 *   `_loadModule()` 一旦拿到 loader，就把「怎么把一个 manifest 变成模块对象」整件事
 *   交给它 —— 并且同时把**默认策略**（第一方 require / 第三方进程内沙箱）也传进去，
 *   于是端口可以只接管自己关心的那部分插件，其余原样委托。
 *
 *   本文件就是那个端口：**第一方委托回默认策略**（它们就是浏览器本身，
 *   必须和主进程共享同一份活对象）；**非第一方则送进独立 utilityProcess**。
 *   infra 因此对"进程隔离"零感知 —— 它只知道"有个 loader 端口"。
 *
 * ── 权限（module 级）──────────────────────────────────────────────
 *   宿主进程里的 `require` 白名单与 `plugin-sandbox.js` 同源（同一张表算出来，
 *   不抄一份），保证"进程内沙箱能拿到的模块"与"进程宿主能拿到的模块"永远一致。
 *
 * ── 与崩溃的关系 ─────────────────────────────────────────────────
 *   宿主崩溃（`process.exit` / 死循环被超时 kill / 原生崩）**只影响它自己**：
 *   客户端把 pending 全部拒绝并回调 `onCrash`，由注册中心落到 `failed`/`autoDisabled`，
 *   其余插件与主进程毫发无损 —— 这正是 PART7 §7.13 的硬指标。
 */

import type { PluginHostClient as PluginHostClientType } from './plugin-host-client'

const fs = require('fs')
const path = require('path')
const { sandbox } = require('@hira-ng/infra-plugin')
const { PluginHostClient } = require('./plugin-host-client')

/** plugin-host.js 与构建产物同目录（构建会按目录结构把 src/main/** 拷到 out/main/**）。 */
const HOST_PATH = path.join(__dirname, 'plugin-host.js')
const MAX_PLUGIN_SOURCE_BYTES = 4 * 1024 * 1024

interface IsolatedPluginManifest { id: string; main?: string; originPath?: string; isFirstParty?: boolean; permissionLevel?: string }
interface PluginLoaderPort { context?: object; loadDefault: () => Promise<object> }
interface PluginIsolationOptions { hostPath?: string; onCrash?: (id: string, error: Error) => void; getGrantedScopes?: (id: string, scopes?: string[]) => string[]; onLog?: (id: string, level: string, message: string) => void; timeoutMs?: number }

/** 由 manifest 推导宿主进程的模块策略。**与进程内沙箱同源**（见文件头注释）。 */
function modulePolicy (m: IsolatedPluginManifest): { allowed: string[]; denied: string[] } {
  const allowed = new Set<string>(sandbox.SAFE_MODULES as string[])
  if (m.permissionLevel === 'network' || m.permissionLevel === 'full') {
    for (const name of sandbox.NETWORK_MODULES as string[]) allowed.add(name)
  }
  return { allowed: Array.from(allowed), denied: Array.from(sandbox.DANGEROUS_MODULES as string[]) }
}

/**
 * 建立隔离端口。
 *
 * @param {object} [options]
 * @param {(id: string, err: Error) => void} [options.onCrash] 宿主崩溃回调（接线到注册中心）
 * @param {(id: string, scopes: string[]) => string[]} [options.getGrantedScopes]
 *        取某插件**已被用户授权**的 scope；缺省 = 空（只放行扩展面，不碰任何数据能力）
 * @param {(id: string, level: string, message: string) => void} [options.onLog]
 * @param {number} [options.timeoutMs]
 * @returns {{ loader: Function, dispose: (id?: string) => void, list: () => string[] }}
 */
function createPluginIsolation (options: PluginIsolationOptions = {}): { loader: (manifest: IsolatedPluginManifest, port: PluginLoaderPort) => Promise<object>; dispose: (id?: string) => void; list: () => string[] } {
  /** pluginId → PluginHostClient */
  const clients = new Map<string, PluginHostClientType>()
  const hostPath = options.hostPath || HOST_PATH
  const onCrash = typeof options.onCrash === 'function' ? options.onCrash : null
  const getGrantedScopes = typeof options.getGrantedScopes === 'function' ? options.getGrantedScopes : null
  const onLog = typeof options.onLog === 'function' ? options.onLog : null
  let disposed = false

  /**
   * `PluginRegistryV2` 的 loader 端口。
   *
   * @param {object} m manifest
   * @param {{ context: object, loadDefault: () => Promise<object> }} port
   */
  async function loader (m: IsolatedPluginManifest, port: PluginLoaderPort): Promise<object> {
    const loadDefault = port.loadDefault
    // 第一方：进程内。它们是浏览器的一部分，且必须要拿到活的 Electron 手柄。
    if (m.isFirstParty) return loadDefault()
    /**
     * **没有 `main` = 声明式插件**（只贡献面板 / 主题 / 命令 / 数据）→ 交回默认策略。
     *
     * 这类插件没有主进程入口可跑，也就不需要宿主进程；默认策略会返回空模块
     * （见 plugin-registry-v2 `loadDefault`），后续 `contributeFromManifest` 只读
     * manifest，面板 / 主题照常生效。隔离端口只决定「谁来跑代码」，不能反过来
     * 要求「每个插件都必须有主进程代码」—— 那会把声明式实现路径判死。
     *
     * 必须在 `disposed` 之前判：这条分支不开进程、不持资源，
     * 「隔离器已关闭」不该拦下根本不需要隔离的插件。
     */
    if (!m.main) return loadDefault()
    if (disposed) throw new Error('插件隔离器已关闭，无法再加载插件宿主')
    if (!m.originPath) throw new Error(`Manifest missing originPath: ${m.id}`)

    const pluginDir = fs.realpathSync(path.dirname(m.originPath))
    const entry = fs.realpathSync(path.resolve(pluginDir, m.main))
    const relativeEntry = path.relative(pluginDir, entry)
    if (!relativeEntry || relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
      throw new Error(`Plugin entry escapes its directory: ${m.id}`)
    }
    if (fs.statSync(entry).size > MAX_PLUGIN_SOURCE_BYTES) {
      throw new Error(`Plugin entry exceeds ${MAX_PLUGIN_SOURCE_BYTES} bytes: ${m.id}`)
    }
    const source = fs.readFileSync(entry, 'utf8')
    const policy = modulePolicy(m)

    // 热重载 / 重新加载：先把上一个宿主收干净，避免同一插件留下两个宿主进程。
    const stale = clients.get(m.id)
    if (stale) {
      clients.delete(m.id)
      stale.dispose()
    }

    const client = new PluginHostClient({
      id: m.id,
      hostPath,
      source,
      entry,
      // 目录边界：宿主内 `require('./helper.cjs')` 只能在本插件目录里解析。
      pluginDir,
      permissionLevel: m.permissionLevel,
      allowedModules: policy.allowed,
      deniedModules: policy.denied,
      grantedScopes: getGrantedScopes ? (getGrantedScopes(m.id) || []) : [],
      context: port.context || {},
      timeoutMs: options.timeoutMs,
      onCrash,
      onLog
    })
    clients.set(m.id, client)
    try {
      return await client.start()
    } catch (e) {
      clients.delete(m.id)
      client.dispose()
      throw e
    }
  }

  /** 收尾：不传 id 则关掉全部宿主（退出时调用）。 */
  function dispose (id?: string): void {
    if (id === undefined) {
      disposed = true
      for (const [, c] of clients) c.dispose()
      clients.clear()
      return
    }
    const c = clients.get(id)
    if (c) {
      clients.delete(id)
      c.dispose()
    }
  }

  function list (): string[] {
    return Array.from(clients.keys())
  }

  return { loader, dispose, list }
}

module.exports = { createPluginIsolation, HOST_PATH }

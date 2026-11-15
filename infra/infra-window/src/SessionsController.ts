/**
 * SessionsController — 每 profile 一个持久 Session（对齐 RT sessions-controller）
 *
 * ── 为什么不用 fromPartition ───────────────────────────────
 * NG 旧实现：所有标签共用一个全局 `WebContentsManager._tabSession`，
 * 切 profile 时用 `setTabSession(newSession)` 全局替换 —— 这导致
 *   1) 已存在的标签仍绑在旧 session 上，切 profile 后新旧 session 混杂；
 *   2) 新标签无法按「自己所属 profile」拿到对应会话；
 *   3) partition 名 `persist:profile-<id>` 与真实磁盘目录脱钩，
 *      扩展/协议/权限注册都挂在一个"全局"会话上，profile 隔离形同虚设。
 *
 * RT 的做法是：每个 profile 一个**独立目录**，用 `session.fromPath(dir)`
 * 直接按目录创建/复用会话，标签按自己的 profileId 取会话。本模块对齐之。
 *
 * ── 解耦（端口注入）────────────────────────────────────────
 * infra 层受分层规则约束**不能 require domain**，因此本模块不认识
 * `profiles/<id>` 这种领域路径。上层（APPS）注入 `resolveProfileDir(profileId)`
 * 端口，把 profileId 翻译成绝对目录。本模块只管「id → Session」的缓存与创建。
 *
 * 无痕：`memory:` 前缀的 ephemeral partition，退出即销毁（对齐 Chrome incognito window）。
 */

import { session, type Session } from 'electron'

interface SessionsControllerOptions { resolveProfileDir: (profileId: string) => string }
export interface SessionResolveOptions { profileId?: string; incognito?: boolean; incognitoPartitionId?: string }
export interface SessionsController {
  get(profileId?: string): Session
  getIncognito(partitionId?: string): Session
  resolve(options?: SessionResolveOptions): Session
  has(profileId?: string): boolean
  forget(profileId?: string): Session | null
  list(): string[]
  listSessions(): Session[]
  listIncognitoSessions(): Session[]
}

/**
 * @param {object} options
 * @param {(profileId: string) => string} options.resolveProfileDir profileId → 绝对目录（APPS 注入）
 * @returns {{
 *   get: (profileId?: string) => Electron.Session,
 *   getIncognito: (partitionId?: string) => Electron.Session,
 *   resolve: (opts?: { profileId?: string, incognito?: boolean, incognitoPartitionId?: string }) => Electron.Session,
 *   has: (profileId?: string) => boolean,
 *   list: () => string[]
 * }}
 */
export function createSessionsController({ resolveProfileDir }: SessionsControllerOptions): SessionsController {
  if (typeof resolveProfileDir !== 'function') {
    throw new Error('createSessionsController: resolveProfileDir 端口必填')
  }

  /** @type {Map<string, Electron.Session>} profileId → 持久会话 */
  const _sessions: Map<string, Electron.Session> = new Map<string, Session>()
  /** @type {Map<string, Electron.Session>} incognitoPartitionId → 临时会话 */
  const _incognito: Map<string, Electron.Session> = new Map<string, Session>()

  /**
   * 取（或创建）某 profile 的持久会话。
   * 同一 profileId 永远返回同一个 Session 实例 —— 标签、扩展、协议注册共用它。
   * @param {string} [profileId]
   * @returns {Electron.Session}
   */
  function get(profileId?: string): Session {
    const id = String(profileId || 'default')
    const cached = _sessions.get(id)
    if (cached) return cached
    const dir = resolveProfileDir(id)
    if (!dir) throw new Error(`createSessionsController: 无法解析 profile 目录: ${id}`)
    const created = session.fromPath(dir)
    _sessions.set(id, created)
    return created
  }

  /**
   * 取（或创建）无痕会话。同一 partitionId 共享，窗口关闭即随进程销毁。
   * @param {string} [partitionId]
   * @returns {Electron.Session}
   */
  function getIncognito(partitionId?: string): Session {
    const key = String(partitionId || 'default')
    const cached = _incognito.get(key)
    if (cached) return cached
    const created = session.fromPartition(`memory:incognito-${key}`, { cache: false })
    _incognito.set(key, created)
    return created
  }

  /**
   * 统一解析入口：按 tab 的 profile/无痕标记给出正确会话。
   * 供 WebContentsManager 的 sessionResolver 端口直接使用。
   * @param {{ profileId?: string, incognito?: boolean, incognitoPartitionId?: string }} [opts]
   * @returns {Electron.Session}
   */
  function resolve(opts: SessionResolveOptions = {}): Session {
    if (opts && opts.incognito) return getIncognito(opts.incognitoPartitionId)
    return get(opts && opts.profileId)
  }

  function has(profileId?: string): boolean {
    return _sessions.has(String(profileId || 'default'))
  }

  /**
   * 释放 controller 对某个已删除 profile Session 的强引用。
   *
   * Electron 没有公开的 Session.destroy()；真正回收由 Chromium 在最后一个
   * WebContents 消失后进行。这里必须至少移除 Map 引用，否则 profile 删除后
   * 扩展、协议、网络策略等对象会跟着 Session 永久留在主进程。
   */
  function forget(profileId?: string): Session | null {
    const id = String(profileId || 'default')
    const existing = _sessions.get(id) || null
    _sessions.delete(id)
    return existing
  }

  function list(): string[] {
    return Array.from(_sessions.keys())
  }

  /**
   * 已经创建出来的**全部** Session 实例（持久 + 无痕）。
   *
   * 为什么需要它：进程级网络策略（代理 / UA）必须**同时**作用到持久会话与无痕会话 ——
   * 只改持久会话的话，"开了代理但无痕窗口仍直连"就是一次静默的隐私泄漏。
   * `list()` 只给 profileId，拿不到实例，故单开这一条。
   *
   * ⚠ 只含**已创建**的会话；未创建的由 `session-created` 钩子在将来补上（见 applier）。
   * @returns {Electron.Session[]}
   */
  function listSessions(): Session[] {
    return [..._sessions.values(), ..._incognito.values()]
  }

  /**
   * 已创建的**无痕**会话实例（不含持久会话）。
   *
   * 用途：L2 物理独立后，网络策略（代理 / UA）是**按 profile**下发的 ——
   * 持久会话只下发"当前 profile 那一个"，但无痕会话没有 profile 归属（临时 partition），
   * 它跟随当前窗口上下文，因此要单独取出来一起下发。
   * @returns {Electron.Session[]}
   */
  function listIncognitoSessions(): Session[] {
    return [..._incognito.values()]
  }

  return { get, getIncognito, resolve, has, forget, list, listSessions, listIncognitoSessions }
}


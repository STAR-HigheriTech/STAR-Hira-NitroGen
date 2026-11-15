import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { ProxyConfig, Session } from 'electron'

// @ts-check
/**
 * settings/appliers/proxy.js — 网络代理生效器（I4）
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 把四个 `network.proxy_*` 设置键变成一次 `session.setProxy(config)`。
 *
 * ⚠ L2（PART16 §5 步骤 5）：代理是**按 profile**的（键在各自设置快照里），因此下发的
 *   对象是「当前 profile 的持久会话 + 无痕会话」—— 由 APPS 注入的 `getSessions` 决定
 *   （不再"全部会话"，否则 A 的代理会盖到 B 的会话上）。切 profile 后由主进程调用
 *   `apply({ force: true })` **强制重下**：目标 profile 的会话可能一次都没配过。
 *
 * 这正是本仓库遗留项目 `js/util/proxy.js` 的装配方式（它是全仓唯一有代理实现的地方），
 * 只是把"遍历 webContents 逐个改 session"换成"从会话控制器取会话实例"——
 * 前者的做法会漏掉**还没有 webContents 的会话**（刚建好、还没开标签的那个）。
 *
 * ── 为什么要为"将来的会话"挂钩子 ──────────────────────────────────
 * 会话是按 profile 懒创建的（切 profile / 开无痕窗口时才 `session.fromPath`）。
 * 没有这个钩子，用户在 A 会话里设好代理、再切到 B 会话 —— B 是新建的，一无所知。
 * 钩子只挂一次（见 `hookInstalled`）。
 *
 * ── 为什么要有指纹去重 ────────────────────────────────────────────
 * `setProxy()` 会让 Chromium **重建该会话的网络栈**（进行中的连接会被打断）。
 * 启动时的全量应用（applyAll）与随后的第一次变更常常算出同一个配置 ——
 * 不去重就是白白打断一次网络。
 *
 * 指纹只解决「连续两次相同」，解决不了「全新的会话 + 默认配置」：默认值是
 * `{mode:'system'}`，而新会话在 Chromium 里本来就是 system —— 对它调一次 setProxy
 * 完全是零收益的网络栈重建（切 profile 的第一次导航会因此变冷）。所以每个会话还记
 * 一笔「是否真的被改过」，命中「从未改过 + 目标为 system」直接跳过。
 *
 * 安全：本模块不 require electron（会话由端口注入），任何失败只告警不抛 ——
 * 网络配置写错不该把主进程带走。
 *
 * @param {object} deps
 * @param {() => Electron.Session[]} deps.getSessions 要下发代理的会话（当前 profile + 无痕）
 * @param {(fn: (session: Electron.Session) => void) => void} [deps.onSessionCreated]
 *   「新会话创建」订阅（APPS 侧包一层 `app.on('session-created')`）
 */

const { PROXY_SETTING_KEYS, proxyConfigFromSettings } = require('@hira-ng/shared-types/src/proxy.mjs') as {
  PROXY_SETTING_KEYS: { mode: string; rules: string; bypassRules: string; pacUrl: string }
  proxyConfigFromSettings(get: (key: string) => unknown): ProxyConfig
}

function createProxyApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const getSessions = typeof deps.getSessions === 'function' ? deps.getSessions : () => []
  const onSessionCreated = typeof deps.onSessionCreated === 'function' ? deps.onSessionCreated : null

  /** 上一次下发过的配置（同时用于指纹去重与"新会话按当前配置补齐"）。 */
  let lastConfig: ProxyConfig | null = null
  let lastFingerprint: string | null = null
  /** 串行链：同一会话的 setProxy 乱序会让**旧配置后到**，必须排队。 */
  let chain: Promise<void> = Promise.resolve()
  let hookInstalled = false
  /** 真正被改成过「非 system」配置的会话（Weak 语义：随会话一起回收）。 */
  const customized = new WeakSet<Session>()

  /** 默认值 = 什么都没设置。命中它就说明"浏览器本来就是这个状态"。 */
  function isDefaultSystem(config: ProxyConfig | null): boolean {
    return !!config && config.mode === 'system'
  }

  /** 对单个会话下发配置（绝不抛）。 */
  function applyTo(session: Session | null | undefined, config: ProxyConfig): void {
    if (!session || typeof session.setProxy !== 'function') return
    // 该会话从未被改过 + 目标就是默认的 system → Chromium 本来就是 system。
    // 此时再 setProxy 只会白白重建一次网络栈（打断正在进行的连接），语义上零变化。
    if (isDefaultSystem(config) && !customized.has(session)) return
    if (!isDefaultSystem(config)) customized.add(session)
    try {
      const res = session.setProxy(config)
      if (res && typeof res.catch === 'function') {
        res.catch((e) => console.warn('[proxy] setProxy failed:', errorMessage(e)))
      }
    } catch (e) {
      console.warn('[proxy] setProxy threw:', errorMessage(e))
    }
  }

  function applyAll(config: ProxyConfig): void {
    for (const session of getSessions()) applyTo(session, config)
  }

  return {
    id: 'network-proxy',
    // 只声明这四个键：其余设置变化与本 applier 无关，不该白跑一次 setProxy。
    keys: [
      PROXY_SETTING_KEYS.mode,
      PROXY_SETTING_KEYS.rules,
      PROXY_SETTING_KEYS.bypassRules,
      PROXY_SETTING_KEYS.pacUrl
    ],
    apply({ settings, force }) {
      if (!settings || typeof settings.get !== 'function') return false
      const config = proxyConfigFromSettings((key) => settings.get(key))

      // 首次应用时挂上"将来创建的会话"钩子 —— 只挂一次，且挂失败要允许下次重试。
      if (!hookInstalled && onSessionCreated) {
        try {
          onSessionCreated((session) => { if (lastConfig) applyTo(session, lastConfig) })
          hookInstalled = true
        } catch (e) {
          console.warn('[proxy] session-created hook failed:', errorMessage(e))
        }
      }

      const fingerprint = JSON.stringify(config)
      // `force` = 切 profile 后的强制重下：新 profile 的会话一次都没配过，
      // 即便配置与上一个 profile 相同也不能被去重跳过（否则它的会话仍直连）。
      if (!force && fingerprint === lastFingerprint) return true
      lastFingerprint = fingerprint
      lastConfig = config
      // 排进串行链：连续两次改动（例如用户改了模式又改规则）顺序才不会倒置。
      chain = chain.then(() => applyAll(config)).catch(() => {})
      return true
    }
  }
}

export { createProxyApplier }

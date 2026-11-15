/**
 * PWA 探测 —— 把「页面线索」变成「安装候选 + 三态通知」的**唯一决策点**。
 *
 * ── 输入 ──────────────────────────────────────────────────────────
 * preload 推来的 `{ documentUrl, manifestUrl, title, themeColor, faviconUrl }`
 * （见 infra/infra-window/preload/pwa-hints）。
 *
 * ── 输出 ──────────────────────────────────────────────────────────
 *  · 候选（candidateStore）：安装管线唯一的输入，含规范化后的 manifest；
 *  · `pwa:detected` 事件：`{ tabId, state, candidateId, appId, kind }`；
 *    state ∈ installed / installable（完整 PWA）/ shortcut（站点应用）/ none。
 *
 * ── 为什么要有 shortcut 态 ────────────────────────────────────────
 * Chromium 的「安装此站点为应用」对**没有 manifest 的站点**也成立（开一个独立窗口）。
 * 文档 §6 只写了 installed/installable/none，实现里多一个 shortcut 态：
 * 地址栏图标仍只在 installable 时亮，主菜单的「安装本页为应用」在 shortcut 时也启用。
 *
 * ── 依赖注入 ──────────────────────────────────────────────────────
 * 不 require runtimeRegistry / BrowserWindow：窗口归属由调用方（ipc/pwa.js）
 * 在 ALS 上下文里解析后传进来，这里只处理纯数据 + 网络。
 */

import type { Session, WebContents } from 'electron'
import {
  rules,
  manifest as manifestRules,
  normalizeStartUrl,
  type NormalizedWebAppManifest,
  type PwaApp,
  type PwaService
} from '@hira-ng/domain-pwa'
import { fetchManifest, discoverPageHints } from '@hira-ng/infra-pwa'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type { CandidateEntry, CandidateStore, PwaCandidate } from './candidate-store'

/** 主进程补采页面线索的超时：比 manifest 更短，安装弹窗不该等一个慢页面。 */
const PAGE_HINTS_TIMEOUT_MS = 5000

function safeUrl(value: unknown): URL | null {
  try { return new URL(String(value || '')) } catch (_) { return null }
}

function ignoreHash(value: unknown): string {
  const u = safeUrl(value)
  if (!u) return ''
  u.hash = ''
  return u.href
}

function hostOf(value: unknown): string {
  const u = safeUrl(value)
  return u ? u.hostname : ''
}

/** 用页面标题兜底应用名（manifest 缺失时）。 */
function fallbackName(title: unknown, documentUrl: unknown): string {
  const clean = String(title || '').replace(/\s+/g, ' ').trim()
  if (clean) return clean.slice(0, 80)
  return hostOf(documentUrl) || '应用'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type PwaDetectionState = 'none' | 'installed' | 'installable' | 'shortcut'

export interface PwaPageHints {
  documentUrl?: string | null
  manifestUrl?: string | null
  title?: string | null
  themeColor?: string | null
  faviconUrl?: string | null
}

export interface PwaDetectionPayload {
  tabId: string
  state: PwaDetectionState
  candidateId: string | null
  appId: string | null
  kind: string | null
}

interface PwaRuntimeTabManager {
  getTabIdByWebContents(sender: WebContents): string | null | undefined
  isIncognitoTab(tabId: string): boolean
  getActiveTabId(): string | null | undefined
  getWebContents(tabId: string): WebContents | null | undefined
}

export interface PwaDetectorRuntime {
  tabManager?: PwaRuntimeTabManager | null
}

export interface PwaDetectorPorts {
  candidateStore: CandidateStore
  pwaService: PwaService
  getProfileId(): string
  emitToWindow(route: string, payload: PwaDetectionPayload): void
  events: { detected: string }
  logger?: { warn?(...args: unknown[]): void }
}

export function createPwaDetector(ports: PwaDetectorPorts) {
  const {
    candidateStore,
    pwaService,
    getProfileId,
    emitToWindow,
    events,
    logger = console
  } = ports

  if (!candidateStore || !pwaService) throw new TypeError('createPwaDetector 缺少 candidateStore / pwaService')
  if (typeof getProfileId !== 'function') throw new TypeError('createPwaDetector 缺少 getProfileId')

  /** tabId → { key, state, candidateId, appId, kind }（用于去重 + 切标签时回放） */
  const lastByTab = new Map<string, PwaDetectionPayload & { key: string }>()
  const MAX_LAST_TABS = 512

  function currentProfile(): string {
    try { return String(getProfileId() || 'default') } catch (_) { return 'default' }
  }

  function rememberLast(tabId: string, value: PwaDetectionPayload & { key: string }): void {
    lastByTab.delete(tabId)
    lastByTab.set(tabId, value)
    while (lastByTab.size > MAX_LAST_TABS) {
      const oldest = lastByTab.keys().next()
      if (oldest.done) break
      lastByTab.delete(oldest.value)
    }
  }

  /** 当前文档是否已属于某个已装应用（按 scope 判定，比起 start_url 精确匹配更接近用户直觉）。 */
  function findInstalled(documentUrl: unknown): PwaApp | null {
    let apps: PwaApp[]
    try { apps = pwaService.list() } catch (_) { return null }
    const target = ignoreHash(documentUrl)
    for (const app of apps) {
      const scope = app.scope || rules.defaultScope(app.startUrl)
      if (scope && rules.isInScope(target, scope)) return app
      if (ignoreHash(app.startUrl) === target) return app
    }
    return null
  }

  /**
   * 组装候选：有规范化 manifest 走完整 PWA，否则退化为站点应用。
   * 两种形态共用同一个形状，安装管线因此只有一条分支（按 kind 决定图标来源）。
   */
  function buildCandidate(hints: PwaPageHints, normalized: NormalizedWebAppManifest | null, profileId: string): PwaCandidate {
    const documentUrl = ignoreHash(hints.documentUrl) || String(hints.documentUrl || '')
    const startUrl = normalized ? normalized.startUrl : (normalizeStartUrl(documentUrl) || documentUrl)
    const scope = normalized ? normalized.scope : rules.defaultScope(startUrl)
    const kind = normalized && rules.classifyInstall(normalized) === 'full' ? 'full' : 'shortcut'
    const appId = rules.makeAppId(profileId, startUrl)
    return {
      appId,
      kind,
      profileId,
      documentUrl,
      manifestUrl: normalized ? normalized.manifestUrl : (hints.manifestUrl || null),
      title: String(hints.title || '').slice(0, 300),
      name: normalized ? normalized.name : fallbackName(hints.title, documentUrl),
      shortName: normalized ? normalized.shortName : null,
      startUrl,
      scope,
      display: normalized ? normalized.display : 'browser',
      themeColor: (normalized && normalized.themeColor) || hints.themeColor || null,
      backgroundColor: (normalized && normalized.backgroundColor) || null,
      icons: (normalized && normalized.icons) || [],
      faviconUrl: hints.faviconUrl || null,
      manifest: normalized || null,
      detectedAt: Date.now()
    }
  }

  function announce(
    _runtime: PwaDetectorRuntime,
    tabId: unknown,
    state: PwaDetectionState,
    entry: CandidateEntry | null,
    extra: { appId?: string | null; kind?: string | null } = {}
  ): PwaDetectionPayload {
    const appId = (entry && entry.candidate.appId) || extra.appId || null
    const payload: PwaDetectionPayload = {
      tabId: String(tabId),
      state,
      candidateId: entry ? entry.id : null,
      appId,
      kind: (entry && entry.candidate.kind) || extra.kind || null
    }
    const key = `${state}|${payload.candidateId || ''}|${appId || ''}|${payload.kind || ''}`
    const previous = lastByTab.get(payload.tabId)
    if (previous && previous.key === key) return payload
    rememberLast(payload.tabId, { ...payload, key })
    try {
      emitToWindow(events.detected, payload)
    } catch (e) {
      logger?.warn?.('[pwa] 推送探测结果失败：', errorMessage(e))
    }
    return payload
  }

  /** 拉 manifest 并规范化；任何失败都按「没有 manifest」处理（不让网络问题挡住站点应用）。 */
  async function resolveManifest(sender: Pick<WebContents, 'session'> | { session: Session | null | undefined }, hints: PwaPageHints): Promise<NormalizedWebAppManifest | null> {
    const manifestUrl = String(hints.manifestUrl || '')
    const documentUrl = String(hints.documentUrl || '')
    if (!isHttpUrl(manifestUrl) || !isHttpUrl(documentUrl)) return null
    // ses.fetch 绕过 CORS，读不到 ACAO；因此强制同源 —— 跨域 manifest 一律不认（更安全）。
    if (!rules.isSameOrigin(manifestUrl, documentUrl)) return null
    const result = await fetchManifest(sender.session, manifestUrl, { timeoutMs: 8000 })
    if (!result || !result.ok) return null
    // Redirects must not turn a same-origin declaration into a cross-origin manifest.
    if (!rules.isSameOrigin(result.manifestUrl || manifestUrl, documentUrl)) return null
    const normalized = manifestRules.normalizeManifest(result.manifest, {
      documentUrl,
      manifestUrl: result.manifestUrl || manifestUrl,
      pageTitle: hints.title
    })
    return normalized || null
  }

  /**
   * 处理一条 preload 线索。
   * @param {{ runtime: object, sender: Electron.WebContents, hints: object }} input
   */
  async function handleCandidate({ runtime, sender, hints }: {
    runtime: PwaDetectorRuntime
    sender: WebContents
    hints: PwaPageHints
  }): Promise<PwaDetectionPayload | null> {
    if (!runtime || !sender || !hints) return null
    const tabManager = runtime.tabManager
    if (!tabManager) return null

    const tabId = tabManager.getTabIdByWebContents(sender)
    if (!tabId) return null
    // 隐身标签不参与安装（装出来会把非隐身 profile 的存储暴露给隐身会话）。
    try { if (tabManager.isIncognitoTab(tabId)) return null } catch (_) {}

    const documentUrl = String(hints.documentUrl || '')
    if (!isHttpUrl(documentUrl)) return null
    // 只认「标签当前还在这个地址」：防止页面在导航瞬间发来的迟到线索。
    const wcUrl = (() => { try { return sender.getURL() } catch (_) { return '' } })()
    if (wcUrl && ignoreHash(wcUrl) !== ignoreHash(documentUrl)) return null

    const profileId = currentProfile()

    // 内容完全相同的重复线索：复用已有候选，省一次 manifest 下载。
    // favicon / theme-color 也要参与比较：迟到的图标线索必须能刷新候选，
    // 否则确认框会一直显示占位图（安装后却换了图标，用户会以为装错了）。
    const existing = candidateStore.getForTab(tabId)
    if (existing &&
        existing.profileId === profileId &&
        existing.candidate.documentUrl === ignoreHash(documentUrl) &&
        (existing.candidate.manifestUrl || null) === (hints.manifestUrl || null) &&
        (existing.candidate.faviconUrl || null) === (hints.faviconUrl || null) &&
        (existing.candidate.themeColor || null) === (hints.themeColor || null) &&
        existing.candidate.title === String(hints.title || '').slice(0, 300)) {
      const installed = findInstalled(documentUrl)
      const state = installed ? 'installed' : (existing.candidate.kind === 'full' ? 'installable' : 'shortcut')
      return announce(runtime, tabId, state, existing, installed ? { appId: installed.id } : {})
    }

    let normalized = null
    try {
      normalized = await resolveManifest(sender, hints)
    } catch (e) {
      logger?.warn?.('[pwa] manifest 拉取失败：', errorMessage(e))
    }

    const candidate = buildCandidate(hints, normalized, profileId)
    const installed = findInstalled(documentUrl)
    // 已安装时仍写候选：点「打开」需要的 appId 就在里面；覆盖安装也从这里取。
    const entry = candidateStore.put({ tabId, profileId, candidate })
    const state = installed ? 'installed' : (candidate.kind === 'full' ? 'installable' : 'shortcut')
    return announce(runtime, tabId, state, entry, installed ? { appId: installed.id } : {})
  }

  /**
   * 主进程补采页面 head 线索。
   *
   * 页面侧 preload 是首选（已在 DOM 里，零网络开销），但它可能错过时机：
   * 打开设置页再回来、标签恢复、preload 注入失败……此时用 `session.fetch`
   * 重拉文档 head（只读前 256KB），至少把 favicon / manifest 补回来。
   *
   * @returns {Promise<{ hints: object, useful: boolean }>}
   *   useful=false 表示没拿到可用线索，调用方应保留已有候选或走纯站点应用兜底。
   */
  async function collectPageHints(wc: WebContents, currentUrl: string): Promise<{ hints: PwaPageHints; useful: boolean }> {
    let fallbackTitle = ''
    try { fallbackTitle = String(wc.getTitle() || '') } catch (_) {}
    const hints: PwaPageHints = {
      documentUrl: ignoreHash(currentUrl),
      manifestUrl: null,
      title: fallbackTitle,
      themeColor: null,
      faviconUrl: null
    }

    let discovered = null
    try {
      discovered = await discoverPageHints(wc.session, currentUrl, { timeoutMs: PAGE_HINTS_TIMEOUT_MS })
    } catch (e) {
      logger?.warn?.('[pwa] 补采页面线索失败：', errorMessage(e))
    }
    if (!discovered || !discovered.ok) return { hints, useful: false }
    // 文档被重定向到了别处（登录页 / 错误页）：线索不属于当前标签，丢弃。
    if (ignoreHash(discovered.documentUrl) !== ignoreHash(currentUrl)) return { hints, useful: false }

    return {
      useful: true,
      hints: {
        documentUrl: ignoreHash(currentUrl),
        manifestUrl: discovered.manifestUrl || null,
        title: discovered.title || fallbackTitle,
        themeColor: discovered.themeColor || null,
        faviconUrl: discovered.faviconUrl || null
      }
    }
  }

  /**
   * 为某个标签准备安装候选（供 `pwa:prepare` 调用）。
   *
   * 候选不存在（比如打开设置页再回来、或页面还没发线索）时：
   *  1. 先用标签当前地址补采页面 head 线索（favicon / manifest / theme-color）；
   *  2. 有同源 manifest 就按完整 PWA 处理，否则退化为站点应用；
   *  3. 全程复核标签地址，导航期间拿到的线索一律作废。
   * 于是"安装本页为应用"在任何页面上都成立，且图标尽量贴近站点真实图标。
   *
   * @param {{ runtime: object, tabId: string }} input
   */
  async function prepare({ runtime, tabId }: { runtime: PwaDetectorRuntime; tabId?: string | null }) {
    const tabManager = runtime && runtime.tabManager
    if (!tabManager) return { ok: false, reason: 'no-runtime' }
    const id = String(tabId || tabManager.getActiveTabId() || '')
    if (!id) return { ok: false, reason: 'no-tab' }
    try { if (tabManager.isIncognitoTab(id)) return { ok: false, reason: 'incognito' } } catch (_) {}

    const wc = tabManager.getWebContents(id)
    if (!wc) return { ok: false, reason: 'no-tab' }
    const currentUrl = (() => { try { return wc.getURL() } catch (_) { return '' } })()
    if (!isHttpUrl(currentUrl)) return { ok: false, reason: 'not-http' }

    const profileId = currentProfile()
    const snapshot = ignoreHash(currentUrl)

    const currentUrlNow = () => {
      try { return wc.getURL() } catch (_) { return '' }
    }
    /** 候选必须属于当前 profile、且仍对应标签现在的地址；否则立即作废。 */
    const usableEntry = () => {
      const found = candidateStore.getForTab(id)
      if (!found) return null
      if (found.profileId !== profileId || ignoreHash(found.candidate.documentUrl) !== snapshot) {
        candidateStore.clearTab(id)
        return null
      }
      return found
    }

    let entry = usableEntry()
    // 已有候选但还不完整（站点应用且没有 favicon）：顺手补采一次，而不是直接复用占位图标。
    const needsEnrich = !entry || (entry.candidate.kind !== 'full' && !entry.candidate.faviconUrl)
    if (needsEnrich) {
      const collected = await collectPageHints(wc, currentUrl)
      if (ignoreHash(currentUrlNow()) !== snapshot) return { ok: false, reason: 'navigated' }

      // await 期间页面自报（或并发的 prepare）已经写好了候选：尊重它，别覆盖。
      const raced = usableEntry()
      if (raced) {
        entry = raced
      } else if (collected.useful) {
        let normalized = null
        try {
          normalized = await resolveManifest({ session: wc.session }, collected.hints)
        } catch (e) {
          logger?.warn?.('[pwa] manifest 拉取失败：', errorMessage(e))
        }
        if (ignoreHash(currentUrlNow()) !== snapshot) return { ok: false, reason: 'navigated' }
        entry = usableEntry() || candidateStore.put({
          tabId: id,
          profileId,
          candidate: buildCandidate(collected.hints, normalized, profileId)
        })
      } else if (!entry) {
        entry = candidateStore.put({
          tabId: id,
          profileId,
          candidate: buildCandidate(collected.hints, null, profileId)
        })
      }
    }

    const installed = findInstalled(currentUrl)
    if (!entry) return { ok: false, reason: 'no-candidate' }
    const candidate = entry.candidate
    return {
      ok: true,
      candidateId: entry.id,
      preview: {
        appId: candidate.appId,
        name: candidate.name,
        shortName: candidate.shortName,
        kind: candidate.kind,
        origin: (safeUrl(candidate.startUrl) || {}).origin || '',
        startUrl: candidate.startUrl,
        themeColor: candidate.themeColor,
        iconUrl: pickPreviewIcon(candidate),
        installedId: installed ? installed.id : null
      }
    }
  }

  /**
   * 预览图标：与最终落盘的图标同序 —— favicon 优先，manifest 最大图标回落。
   * 确认框里看到的那张必须就是装完后的那张，否则用户会以为安装把图标换掉了。
   */
  function pickPreviewIcon(candidate: PwaCandidate): string | null {
    if (candidate.faviconUrl) return candidate.faviconUrl
    const best = manifestRules.pickBestIcon(candidate.icons || [], { targetSize: 512 })
    return (best && best.src) || null
  }

  /** 当前标签的探测结果（切标签 / 首帧查询用；不创建候选）。 */
  function stateForTab(tabId: unknown): Omit<PwaDetectionPayload, 'tabId'> {
    const id = String(tabId || '')
    if (!id) return { state: 'none', candidateId: null, appId: null, kind: null }
    const last = lastByTab.get(id)
    if (last) {
      if (!last.candidateId || candidateStore.get(last.candidateId)) {
        return { state: last.state, candidateId: last.candidateId, appId: last.appId, kind: last.kind }
      }
      lastByTab.delete(id)
    }
    return { state: 'none', candidateId: null, appId: null, kind: null }
  }

  /** 标签关闭 / 导航离开：丢掉候选与上次状态。 */
  function clearTab(tabId: unknown): void {
    const id = String(tabId || '')
    if (!id) return
    candidateStore.clearTab(id)
    lastByTab.delete(id)
  }

  /** profile 切换 / 关闭窗口：清掉属于它的内存候选。 */
  function clearProfile(profileId: unknown): void {
    candidateStore.clearProfile(profileId)
    for (const [tabId, last] of lastByTab) {
      if (!last || !last.candidateId) continue
      if (!candidateStore.get(last.candidateId)) lastByTab.delete(tabId)
    }
  }

  return {
    handleCandidate,
    prepare,
    stateForTab,
    clearTab,
    clearProfile,
    findInstalled
  }
}

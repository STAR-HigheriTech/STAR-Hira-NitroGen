import type { Session } from 'electron'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { SettingsServicePort, SettingsSync } from './settings'

interface ProfileRecord { id: string; [key: string]: unknown }
interface SpaceRecord { id: string; profileId: string; [key: string]: unknown }
interface RuntimeTabManager {
  list(): unknown[]
  newTab(options: { url: string }): unknown
  setCurrentSpace(profileId: string, spaceId: string): unknown
  getActiveTabId?(): string | null
}
interface RuntimePort {
  isPrimary?: boolean
  ordinal?: unknown
  tabManager?: RuntimeTabManager
  win?: { id?: number; isDestroyed?(): boolean }
  webSidebar?: { destroy?(): unknown }
  spaceRuntime?: { getCurrent?(): { profileId: string; spaceId: string }; setCurrent?(scope: { profileId: string; spaceId: string }): unknown }
}
interface ExtensionServicePort { session: Session; [key: string]: unknown }
interface DownloadControllerPort { [key: string]: unknown }

interface ProfileSpaceDependencies {
  browserWindows: { all(): RuntimePort[]; focused?(): RuntimePort | null | undefined }
  primaryWindow: RuntimePort
  runtimeRegistry: {
    runWithProfile?<T>(profileId: string, task: () => T): T
    runWithScope?<T>(profileId: string, spaceId: string, task: () => T): T
    currentOrNull(): RuntimePort | null | undefined
  }
  spaceRuntime: { setCurrent(scope: { profileId: string; spaceId: string }): unknown }
  profileService: { setActive(profileId: string): unknown; get(profileId: string): ProfileRecord | null | undefined }
  spaceService: {
    list(profileId: string): SpaceRecord[]
    get(profileId: string, spaceId: string): SpaceRecord | null | undefined
    setLastUsed(profileId: string, spaceId: string): unknown
  }
  settingsService: SettingsServicePort
  passwordService: { setProfile(profileId: string): unknown }
  permissionService: { rejectAllPending(): unknown }
  getActiveProfile(): ProfileRecord | null | undefined
  setActiveProfile(profile: ProfileRecord | null | undefined): unknown
  getActiveSpace(): SpaceRecord | null | undefined
  setActiveSpace(space: SpaceRecord | null | undefined): unknown
  resolveProfileDir(profileId: string): string
  sessionDirFor(profileId: string, spaceId: string): string
  runtimeCurrentSpace(runtime: RuntimePort): { profileId: string; spaceId: string }
  saveSpaceSession(runtime: RuntimePort, dir: string, options: Record<string, unknown>): Promise<unknown>
  restoreSpaceSession(runtime: RuntimePort, dir: string): Promise<{ restored?: boolean } | null | undefined>
  defaultNewTabUrl(): string
  resolveStartupSpace(profile: ProfileRecord | null | undefined): SpaceRecord
  registerDownloadHandler(session: Session, service: unknown, options: Record<string, unknown>): DownloadControllerPort
  slotCall: {
    reduce(name: string, payload: unknown, context: unknown): Record<string, unknown> | null | undefined
    emit(name: string, payload: unknown): Promise<unknown>
  }
  emit(route: string, payload: unknown): unknown
  getOrCreateExtensionService(profileId: string): Promise<ExtensionServicePort | null | undefined>
  getExtensionService(): ExtensionServicePort | null | undefined
  setExtensionService(service: ExtensionServicePort | null | undefined): unknown
  getStopExtensionRelay(): { setService(service: ExtensionServicePort): unknown } | null | undefined
  registerHiraProtocol(session: Session): unknown
  pluginProtocolOptions: unknown
  registerPluginProtocol(session: Session, options: unknown): unknown
  themeAssetRoot: string
  registerThemeAssetProtocol(session: Session, options: { root: string }): unknown
  externalGames: { registerOn(session: Session): unknown }
  permissionRuntime: { attachProfile(session: Session, profileId: string): unknown }
  getDownloadController(): DownloadControllerPort | null | undefined
  setDownloadController(controller: DownloadControllerPort | null | undefined): unknown
  resolveDownloadSavePath?(input: { url: string; filename: string; mimeType?: string; directory: string }): { directory: string; filename: string }
  onDownloadCompleted?(input: { id: string; filePath: string }): void
  downloadServiceFor(profileId: string): unknown
  win: unknown
  getGuardDownload(): unknown
  openDownloadPanelFor: unknown
  onProfileContextChanged?(profileId: string): void
  STARTUP_SETTING_KEYS: { mode: string }
  SPACE_SCOPED_SETTING_KEYS: readonly string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Profile / Space 切换协调器。
 *
 * 应用级 Profile 身份、窗口级 Space 投影、设置重放、扩展 Session 重绑和会话恢复
 * 收敛在这里。所有可变状态通过显式 getter/setter 端口回写组合根，避免把切换规则
 * 继续堆在 main.js。
 *
 * @param {object} deps
 */
export function createProfileSpaceCoordinator({
  browserWindows,
  primaryWindow,
  runtimeRegistry,
  spaceRuntime,
  profileService,
  spaceService,
  settingsService,
  passwordService,
  permissionService,
  getActiveProfile,
  setActiveProfile,
  getActiveSpace,
  setActiveSpace,
  resolveProfileDir,
  sessionDirFor,
  runtimeCurrentSpace,
  saveSpaceSession,
  restoreSpaceSession,
  defaultNewTabUrl,
  resolveStartupSpace,
  registerDownloadHandler,
  slotCall,
  emit,
  getOrCreateExtensionService,
  getExtensionService,
  setExtensionService,
  getStopExtensionRelay,
  registerHiraProtocol,
  pluginProtocolOptions,
  registerPluginProtocol,
  themeAssetRoot,
  registerThemeAssetProtocol,
  externalGames,
  permissionRuntime,
  getDownloadController,
  setDownloadController,
  resolveDownloadSavePath,
  onDownloadCompleted,
  downloadServiceFor,
  win,
  getGuardDownload,
  openDownloadPanelFor,
  onProfileContextChanged,
  STARTUP_SETTING_KEYS,
  SPACE_SCOPED_SETTING_KEYS
}: ProfileSpaceDependencies) {
  let activeProfile = getActiveProfile()
  let activeSpace = getActiveSpace()
  let extensionService: ExtensionServicePort | null = getExtensionService() || null
  let downloadController: DownloadControllerPort | null = getDownloadController() || null
  let appliedProfileContextId = String(activeProfile?.id || 'default')
  /** 最近一次 profile session 上下文的请求代际；旧任务完成时据此整段作废。 */
  let profileSessionGeneration = 0
  let requestedProfileContext: { profileId: string; spaceId: string } | null = null
  let profileSessionTask: Promise<void> | null = null

  /**
   * 窗口级切换代际。所有异步收尾（会话恢复 / 保存 / 数据广播）在落地前都核对它，
   * 防止快速连点后旧任务把新空间的状态覆盖回去。WeakMap 不额外持有窗口对象。
   */
  const switchRevisions = new WeakMap<RuntimePort, number>()
  /** profile 级选择代际：用于拒绝排队中的旧主题 / 网络 applier。 */
  let profileSelectionRevision = 0

  function nextSwitchRevision(rt: RuntimePort): number {
    const next = (switchRevisions.get(rt) || 0) + 1
    switchRevisions.set(rt, next)
    return next
  }

  function isSwitchCurrent(rt: RuntimePort, revision: number): boolean {
    return switchRevisions.get(rt) === revision
  }

  function runInScope<T>(profileId: string, spaceId: string, task: () => T): T {
    if (typeof runtimeRegistry.runWithScope === 'function') {
      return runtimeRegistry.runWithScope(profileId, spaceId, task)
    }
    if (typeof runtimeRegistry.runWithProfile === 'function') {
      return runtimeRegistry.runWithProfile(profileId, task)
    }
    return task()
  }

  async function ensureSpaceSessionOrTab(
    rt: RuntimePort,
    space: SpaceRecord,
    shouldContinue: () => boolean = () => true
  ): Promise<void> {
    if (!rt || !rt.tabManager) return
    if (!shouldContinue()) return
    // list() 是「当前空间」的投影：非空说明这个空间本来就有标签，不动它。
    if (safeSpaceTabCount(rt) > 0) return

    if (settingsService.get(STARTUP_SETTING_KEYS.mode) === 'last_session') {
      try {
        // 空间会话走**按窗口仲裁**的唯一入口（见 saveSpaceSession 的说明）：
        // 主窗口读规范 session.json，其它窗口读自己的窗口分片 —— 绝不能用全局
        // sessionService（那会让非主窗口读到/覆盖主窗口的规范会话）。
        const dir = sessionDirFor(space.profileId, space.id)
        const result = await restoreSpaceSession(rt, dir)
        if (!shouldContinue()) return
        if (result && result.restored && safeSpaceTabCount(rt) > 0) {
          console.log('[main] space session restored:', space.profileId, '/', space.id)
          return
        }
      } catch (e) {
        console.error('[main] 空间会话恢复失败:', errorMessage(e))
      }
    }
    if (shouldContinue()) ensureSpaceHasTab(rt)
  }

  /** 当前空间的标签数；探测失败按「有标签」处理 —— 宁可不动，也不要误判成空而重复灌一份。 */
  function safeSpaceTabCount(rt: RuntimePort): number {
    try {
      return rt.tabManager?.list().length || 0
    } catch (_) {
      return 1
    }
  }

  /**
   * 目标空间确实是空的 → 补一个「新标签页」，对齐「每个窗口永远至少有一个新标签页」。
   * @param {object} rt 窗口运行单元
   */
  function ensureSpaceHasTab(rt: RuntimePort | null | undefined): void {
    if (!rt || !rt.tabManager) return
    try {
      if (safeSpaceTabCount(rt) > 0) return
      const url = defaultNewTabUrl()
      Promise.resolve(rt.tabManager.newTab({ url: url || 'about:blank' })).catch((e) => {
        console.error('[main] 空空间补新标签失败:', errorMessage(e))
      })
    } catch (e) {
      console.error('[main] 空空间补新标签失败:', errorMessage(e))
    }
  }

  /** 串行保存旧空间会话：首帧之后再快照，避免点击当拍同步拷贝全部导航历史。 */
  let sessionSaveChain: Promise<void> = Promise.resolve()
  const queuedSessionSaves = new Set<string>()
  function scheduleSpaceSessionSave(
    rt: RuntimePort,
    space: { profileId: string; spaceId: string },
    dir: string,
    options: Record<string, unknown> = { space }
  ): void {
    const key = `${String(rt.win?.id || rt.ordinal || 0)}\u0000${space.profileId}\u0000${space.spaceId}`
    if (queuedSessionSaves.has(key)) return
    queuedSessionSaves.add(key)
    setTimeout(() => {
      // 从「等首帧」队列移除后，紧接着发生的新改动仍能排下一份保存；
      // 实际写盘依旧由 sessionSaveChain 串行，不会互相覆盖。
      queuedSessionSaves.delete(key)
      sessionSaveChain = sessionSaveChain.then(async () => {
        try {
          if (rt.win && typeof rt.win.isDestroyed === 'function' && rt.win.isDestroyed()) return
          await saveSpaceSession(rt, dir, options)
        } catch (e) {
          console.error('[main] save session before context switch failed:', errorMessage(e))
        }
      })
    }, 24)
  }

  /** 首帧之后再恢复目标空间：点击任务只负责把新投影和主题推上屏。 */
  function scheduleSpaceHydration(rt: RuntimePort, space: SpaceRecord, revision: number): void {
    setTimeout(() => {
      if (!isSwitchCurrent(rt, revision)) return
      void ensureSpaceSessionOrTab(rt, space, () => isSwitchCurrent(rt, revision))
    }, 16)
  }

  /**
   * 设置生效链路的**晚绑定句柄**（`settings.sync` 的协调器）。
   * 它在下方 `bootstrapPostIpcModules` 才创建，而本文件早于此就要定义切换流程 ——
   * 用可变引用解时序，与 `historyServiceRef` / `slotLifecycleRef` 同一口径。
   */
  let settingsSyncRef: SettingsSync | null = null

  /**
   * 上次重放过的**同一 scope**内的空间级设置值。
   *
   * 去重键必须包含 profile + space：只按「值」去重会让 B/profile 的默认主题
   * 被 A/profile 已发过的同值挡掉，跨 profile 切换时 UI 永远收不到恢复信号。
   * 该表只保留当前 scope 的少量键，不随空间数量无界增长。
   */
  let lastReplayedScope = ''
  const lastReplayedSpaceSettings = new Map<string, string>()

  /**
   * **切空间后重放「按空间」的设置**（B2 / J13）。
   *
   * 为什么必须有这一步：空间层是读取期解析的（profileOverlay 的 `get()` 现读当前空间），
   * 但它**不产生事件** —— 没有它，切空间后 UI 仍显示上一个空间的主题，直到用户手动改一次设置。
   *
   * 为什么逐个 key 发 `scope:'one'` 而不是一次 `scope:'all'`：`all` 会让**每一个**渲染层
   * 全量重读设置 + 重取面板数据（切空间本来就够重了），而真正变的只有这几项。
   * 值在此刻显式 scope 读出；广播立即发出，applier 则携带同一 scope 进入串行链。
   * 切换不再等 applier 完成，渲染层能先拿到主题值并通过 theme:tokens 立刻换色，
   * 原生材质 / 网络等较重收尾在后台继续。
   */
  function replaySpaceScopedSettings(
    scope?: { profileId?: string; spaceId?: string },
    options: { force?: boolean; shouldApply?: () => boolean } = {}
  ): void {
    const sync = settingsSyncRef
    if (!sync || typeof sync.emit !== 'function') return
    const runtimeScope = runtimeRegistry.currentOrNull()?.spaceRuntime?.getCurrent?.() || null
    const profileId = String(scope?.profileId || runtimeScope?.profileId || activeProfile?.id || 'default')
    const spaceId = String(scope?.spaceId || runtimeScope?.spaceId || activeSpace?.id || 'default')
    const scopeKey = `${profileId}\u0000${spaceId}`
    if (scopeKey !== lastReplayedScope) {
      lastReplayedScope = scopeKey
      lastReplayedSpaceSettings.clear()
    }
    for (const key of SPACE_SCOPED_SETTING_KEYS) {
      try {
        const value = runInScope(profileId, spaceId, () => settingsService.get(key))
        let sig = ''
        try { sig = JSON.stringify(value) ?? '' } catch { sig = String(value) }
        if (!options.force && lastReplayedSpaceSettings.get(key) === sig) continue
        lastReplayedSpaceSettings.set(key, sig)
        const change = {
          scope: 'one' as const,
          key,
          value,
          profileId,
          spaceId,
          ...(options.shouldApply ? { shouldApply: options.shouldApply } : {})
        }
        // 先推渲染层（同拍、无 IPC 往返等待），再排队跑主进程 applier。
        try { sync.broadcast(change) } catch (_) {}
        void sync.emit(change, { broadcast: false }).catch((e) => {
          console.warn(`[settings] 切空间应用 ${key} 失败:`, errorMessage(e))
        })
      } catch (e) {
        console.warn(`[settings] 切空间重放 ${key} 失败:`, errorMessage(e))
      }
    }
  }

  /** 同步提交 profile 身份：这是“当前是谁”的内存/DB 事实，必须早于任何异步会话创建。 */
  function commitProfileIdentity(profileId: string): ProfileRecord | null {
    const pid = String(profileId || 'default')
    try { profileService.setActive(pid) } catch (e) {
      console.error('[main] setActive profile failed:', errorMessage(e))
    }
    activeProfile = profileService.get(pid)
    setActiveProfile(activeProfile)
    try { passwordService.setProfile(pid) } catch (e) {
      console.error('[main] set password profile failed:', errorMessage(e))
    }
    try { permissionService.rejectAllPending() } catch (_) {}
    return activeProfile || null
  }

  /**
   * profile 级数据刷新：只广播事实，不等待扩展 / 网络 / 会话恢复。
   *
   * 所有数据 IPC 都按发送窗口的 spaceRuntime 解析 profile，而此刻目标投影已经完成，
   * 因此渲染层收到事件后拉到的就是目标 profile/space 的数据。重的 session 上下文
   * 由后台继续收敛，最后再用 extension:changed 刷新依赖扩展服务的局部 UI。
   */
  function notifyProfileContextChanged(profileId: string, spaceId: string): void {
    const pid = String(profileId || 'default')
    const sid = String(spaceId || 'default')
    try { onProfileContextChanged?.(pid) } catch (_) {}

    try {
      if (settingsSyncRef && typeof settingsSyncRef.broadcast === 'function') {
        settingsSyncRef.broadcast({ scope: 'all', profileId: pid, spaceId: sid })
      }
    } catch (e) {
      console.error('[main] broadcast settings:changed(all) failed:', errorMessage(e))
    }
    try { emit(IPC_EVENTS.profileChanged, { profileId: pid, spaceId: sid }) } catch (e) {
      console.error('[main] broadcast profile:changed failed:', errorMessage(e))
    }

    // 独立侧栏绑定在旧 session 上；旧身份不能继续留在屏幕上。
    for (const rt of browserWindows.all()) {
      try {
        if (rt.webSidebar && typeof rt.webSidebar.destroy === 'function') rt.webSidebar.destroy()
      } catch (_) {}
    }
  }

  /**
   * **profile 上下文改变之后**的统一收尾（切 profile 与"跨 profile 切空间"共用一处）。
   *
   * 这一步以前完全没有 —— 于是「切了 profile，整套界面还在用上一个 profile 的东西」：
   *   · 设置：applier 没重跑（主题 / 布局 / 侧栏位置 / 面板宽度…全是旧用户的），
   *     渲染层也还缓存着旧值，设置页更是原样显示上一个用户的勾选；
   *   · 数据：书签栏、各面板里全是旧 profile 的书签 / 历史 / 下载，
   *     **不手动关掉重开就一直留着**；独立侧栏更狠 —— 它那条 session 是旧用户的，
   *     等于把上一个用户的登录态留在屏幕上。
   * 现在拆成快慢两拍：
   *   · `notifyProfileContextChanged()` 在投影完成的同一拍广播设置全量重读 + profile 数据
   *     刷新，并销毁绑定旧 session 的独立侧栏 —— 用户立即看到目标身份；
   *   · `afterProfileContextChanged()` 在后台扩展会话就绪后合作式重跑 applier，
   *     再发 `extension:changed` 刷新依赖扩展服务的局部 UI。
   *
   * 为什么不在这里挨个分发各领域自己的 changed 事件：那要 main.js 认识每一个域的事件名，
   * 而且"某个域的数据变了"与"你看的这整套东西换主人了"本来就是两件事 —— 后者是 profile 级事实。
   *
   * @param {string} profileId 切换后的 profile（applier 按它）
   */
  async function afterProfileContextChanged(
    profileId: string,
    scope?: { spaceId?: string },
    generation?: number
  ): Promise<void> {
    const pid = String(profileId || 'default')
    const sid = String(scope?.spaceId || activeSpace?.id || 'default')
    const isCurrent = () => generation == null || generation === profileSessionGeneration

    // 显式钉住 profile + space：applier 内部全靠 settings.get 现取，不能依赖调用栈
    // 恰好还挂着目标上下文。合作式执行在每个 applier 之间让出一拍，避免长任务冻结 UI。
    try {
      await runInScope(pid, sid, async () => {
        const sync = settingsSyncRef
        if (!sync) return
        if (typeof sync.applyAllAsync === 'function') {
          await sync.applyAllAsync({}, { shouldContinue: isCurrent })
        } else if (typeof sync.applyAll === 'function') {
          sync.applyAll()
        }
        if (!isCurrent()) return
        // 有指纹去重的网络类 applier（代理 / UA）必须**强制**重下一次（PART16 §5）：
        // 目标 profile 的会话一次都没配过，配置恰好与上一个 profile 相同也会被去重跳过。
        if (typeof sync.applyApplier === 'function') {
          sync.applyApplier('network-proxy', { force: true })
          sync.applyApplier('network-user-agent', { force: true })
        }
      })
    } catch (e) {
      console.error('[main] re-apply settings after profile switch failed:', errorMessage(e))
    }

  }

  /**
   * 把「profile 侧的那一整套」切到目标 profile：全局身份 → 扩展系统 → 协议 → 权限 → 下载。
   *
   * ── 为什么必须单独抽出来（两件事）────────────────────────────────
   * 1. 它以前在 `switchProfile` 与 `switchSpaceOnRuntime` 里**各抄了一份**，两份只差一个
   *    变量名 —— 典型的"改一处忘一处"结构，抽成一处后跨 profile 的两条路必然同行为。
   * 2. ⚠ **每一步都只记录失败、绝不上抛**。这一整套与"用户要去哪儿"是两件事：
   *    用户点的是「切到那个 profile」，标签 / 空间 / 设置 / 整套界面**必须**切过去；
   *    扩展系统建不起来只该让扩展降级，不该把整次切换掀翻。
   *
   * ── 这条护栏修掉的是哪个 bug ────────────────────────────────────
   * 以前 `await getOrCreateExtensionService(...)` **没有**护栏，而它恰好是
   * 「全局状态已经改完（`profileService.setActive` / `activeProfile` 已是目标）」之后、
   * 「投影（`setCurrentSpace`）之前」**唯一**的 await。一旦它抛（新建 ECE、目标 session
   * 尚未就绪等），函数就地中断：
   *   · 窗口还停在上一个 profile 的标签上 → 用户看到「点了没反应」；
   *   · 全局 activeProfile 却已经变成目标 → 第二次点被 `sameActiveProfile` 判成
   *     "profile 侧已经切好了"，**整段跳过**，投影才第一次跑到 → 「要点两次才生效」。
   * 所以根因不是"要点两次"，而是**半途中断 + 全局状态被写脏**；把每一步兜住，
   * 第一次点就一定会走到投影。
   *
   * @param {string} profileId 目标 profile
   * @returns {Promise<{ extension: boolean }>} extension=false 表示扩展侧已降级
   */
  async function applyProfileSessionContext(
    profileId: string,
    generation: number
  ): Promise<{ extension: boolean; stale?: boolean }> {
    const pid = String(profileId || 'default')
    const isCurrent = () => generation === profileSessionGeneration && String(activeProfile?.id || 'default') === pid

    if (pid === appliedProfileContextId && extensionService) return { extension: true }

    // ── 扩展系统：**可失败**，失败即降级（本次切换继续）──
    let nextExtensionService: ExtensionServicePort | null = null
    try {
      // 缓存复用，避免 ECE 重复实例化错误（单飞加载器见 getOrCreateExtensionService）
      nextExtensionService = (await getOrCreateExtensionService(pid)) ?? null
    } catch (e) {
      console.error(`[main] 目标 profile(${pid}) 的扩展系统创建失败 —— 本次切换继续，扩展侧降级:`, errorMessage(e))
      if (isCurrent()) {
        extensionService = null
        setExtensionService(null)
        appliedProfileContextId = ''
      }
      return { extension: false }
    }
    // 创建期间用户已经切到别处：旧会话绝不能覆盖新 profile 的全局扩展服务。
    if (!isCurrent()) return { extension: false, stale: true }
    if (!nextExtensionService) {
      extensionService = null
      setExtensionService(null)
      appliedProfileContextId = ''
      return { extension: false }
    }

    extensionService = nextExtensionService
    setExtensionService(extensionService)
    appliedProfileContextId = pid
    // 以下都是"挂到目标会话上"的旁路动作：任何一条失败都只影响它自己
    try {
      const relay = getStopExtensionRelay()
      if (relay && typeof relay.setService === 'function') relay.setService(extensionService)
    } catch (e) { console.error('[main] extension relay re-bind failed:', errorMessage(e)) }
    try { registerHiraProtocol(extensionService.session) } catch (e) {
      console.error('[main] registerHiraProtocol failed:', errorMessage(e))
    }
    try { registerPluginProtocol(extensionService.session, pluginProtocolOptions) } catch (e) {
      console.error('[main] registerPluginProtocol failed:', errorMessage(e))
    }
    // 主题背景图与插件资产同一条道理：切换 profile 会换会话，协议要在新会话上重挂一遍
    try { registerThemeAssetProtocol(extensionService.session, { root: themeAssetRoot }) } catch (e) {
      console.error('[main] registerThemeAssetProtocol failed:', errorMessage(e))
    }
    try { externalGames.registerOn(extensionService.session) } catch (e) {
      console.error('[main] externalGames registerOn failed:', errorMessage(e))
    }
    try { permissionRuntime.attachProfile(extensionService.session, pid) } catch (e) {
      console.error('[main] re-register permission handlers failed:', errorMessage(e))
    }
    try {
      downloadController = registerDownloadHandler(extensionService.session, downloadServiceFor(pid), {
        emit,
        settingsService,
        parentWindow: win,
        // 站点守卫（自动下载）：切 session 后仍用同一份判定规则（见 site-guard.js）
        guardDownload: getGuardDownload(),
        // 自动打开下载面板：与首次注册同一份回调（profile 切换不改变选边语义）
        onDownloadStarted: openDownloadPanelFor,
        resolveSavePath: resolveDownloadSavePath,
        onDownloadCompleted
      })
      setDownloadController(downloadController)
    } catch (e) {
      console.error('[main] re-register download handler failed:', errorMessage(e))
    }
    return { extension: true }
  }

  /**
   * profile session 上下文的后台单飞调度器。
   *
   * 点击只负责身份 + 投影 + 主题/数据通知，扩展与协议绑定在这里继续。连续切换时
   * 后一次请求覆盖前一次的 pending 目标；旧请求即使晚完成也会被代际判废，绝不
   * 反向覆盖最后一次选择。
   */
  function scheduleProfileSessionContext(profileId: string, spaceId: string): number {
    const pid = String(profileId || 'default')
    const sid = String(spaceId || 'default')
    const generation = ++profileSessionGeneration
    requestedProfileContext = { profileId: pid, spaceId: sid }
    if (!profileSessionTask) {
      // 让切换 IPC 的响应与新主题/标签投影先完成两帧，再启动可能同步建 ECE 的重活。
      profileSessionTask = new Promise<void>((resolve) => setTimeout(resolve, 32))
        .then(async () => {
          while (requestedProfileContext) {
            const target = requestedProfileContext
            requestedProfileContext = null
            const targetGeneration = profileSessionGeneration
            const result = await applyProfileSessionContext(target.profileId, targetGeneration)
            if (targetGeneration !== profileSessionGeneration) continue
            // 扩展会话一就绪就先刷依赖它的局部 UI，不等后面的全量 applier 收尾。
            try {
              emit(IPC_EVENTS.extensionChanged, {
                profileId: target.profileId,
                spaceId: target.spaceId,
                reason: result.extension ? 'profile-context-ready' : 'profile-context-degraded'
              })
            } catch (_) {}
            await afterProfileContextChanged(target.profileId, { spaceId: target.spaceId }, targetGeneration)
          }
        })
        .catch((e) => {
          console.error('[main] profile context hydration failed:', errorMessage(e))
        })
        .finally(() => {
          profileSessionTask = null
          if (requestedProfileContext) {
            const next = requestedProfileContext
            requestedProfileContext = null
            scheduleProfileSessionContext(next.profileId, next.spaceId)
          }
        })
    }
    return generation
  }

  async function waitForProfileSessionContext(generation: number): Promise<boolean> {
    while (profileSessionTask) await profileSessionTask
    return generation === profileSessionGeneration
  }

  /** 兼容组合根既有入口：提交身份后立即启动同一条后台 session 上下文链。 */
  async function applyProfileContext(profileId: string): Promise<{ extension: boolean }> {
    const pid = String(profileId || 'default')
    commitProfileIdentity(pid)
    const generation = scheduleProfileSessionContext(pid, String(activeSpace?.id || 'default'))
    return { extension: generation > 0 }
  }

  // 流程：保存当前标签 → 关闭所有标签 → 切换扩展 session → 恢复目标 profile 标签 → 刷新 UI
  async function switchProfile(profileId: string) {
    console.log('[main] switching profile to:', profileId)
    const oldProfileId = activeProfile?.id || 'default'

    /**
     * `profile.on-before-switch`（REDUCE，可拦截）—— 给插件一次"切换前"的机会。
     *
     * 为什么放在**最前面**（早于保存会话）：能拦就要尽早拦。若等到会话都保存完、
     * 扩展 session 都换过了才发现"不该切"，那就得回滚一串副作用 —— 而回滚总是比不开始更糟。
     *
     * 拦截约定：实现返回 `{ ...acc, cancel: true }`。用 REDUCE 而不是 EVENT，
     * 正是因为要允许"后面的实现看到前面实现的决定"（比如第一个拦了，后面的就不必再算）。
     */
    const gate = slotCall.reduce('profile.on-before-switch',
      { from: oldProfileId, to: profileId },
      { from: oldProfileId, to: profileId })
    if (gate && gate.cancel === true) {
      console.log(`[main] profile 切换被插件拦截：${oldProfileId} → ${profileId}`)
      return { ok: false, cancelled: true, reason: gate.reason || '被插件拦截' }
    }

    const targetProfile = profileService.get(profileId)
    if (!targetProfile) return { ok: false, reason: 'profile not found' }
    const targetProfileId = String(targetProfile.id || 'default')
    const targetSpace = resolveStartupSpace(targetProfile)
    const windows = browserWindows.all()
    const selectionRevision = ++profileSelectionRevision

    // 1. 旧空间会话延后一拍串行保存。`listForPersist` 会同步复制每条导航历史，
    //    绝不能压在点击当拍；目标投影与主题先上屏，落盘在后台继续。
    const switchedWindows: Array<{ rt: RuntimePort; revision: number }> = []
    for (const rt of windows) {
      if (!rt.tabManager) continue
      const spot = runtimeCurrentSpace(rt)
      const dir = rt.isPrimary ? resolveProfileDir(spot.profileId) : sessionDirFor(spot.profileId, spot.spaceId)
      let activeTabId: string | null = null
      try { activeTabId = rt.tabManager.getActiveTabId?.() || null } catch (_) {}
      scheduleSpaceSessionSave(rt, spot, dir, {
        allTabs: true,
        profileId: spot.profileId,
        activeTabId
      })
      switchedWindows.push({ rt, revision: nextSwitchRevision(rt) })
    }

    // 2. 先把组合根的目标空间写定。真正的 profile 身份在窗口投影完成后提交，
    //    这样任何同步监听器看到的都是「新窗口作用域 + 新全局身份」的完整组合。
    activeSpace = targetSpace
    setActiveSpace(activeSpace)

    // 3. 一次性完成所有窗口的可见投影。必须让 TabManager 自己先读旧空间再写新空间：
    //    提前 spaceRuntime.setCurrent 会把 prev 抹成目标，旧空间标签因此永远不休眠。
    for (const { rt, revision } of switchedWindows) {
      try { rt.tabManager?.setCurrentSpace(targetSpace.profileId, targetSpace.id) } catch (e) {
        console.error('[main] project target profile space failed:', errorMessage(e))
      }
      if (rt.isPrimary) spaceRuntime.setCurrent({ profileId: targetSpace.profileId, spaceId: targetSpace.id })
      scheduleSpaceHydration(rt, targetSpace, revision)
    }

    // 投影已就绪后再提交身份（内存 + DB），但依然不等扩展加载。
    commitProfileIdentity(targetProfileId)
    // lastUsed 只影响下次排序，不参与当前首帧；放到这一拍之后落库，避免 SQLite
    // 写事务压在点击响应上。快速连切只有最后一次目标会被记录。
    setTimeout(() => {
      if (selectionRevision !== profileSelectionRevision) return
      if (String(activeProfile?.id || 'default') !== targetProfileId) return
      try { spaceService.setLastUsed(targetSpace.profileId, targetSpace.id) } catch (_) {}
    }, 16)

    // 4. 主题与空间级设置在投影后的同一拍广播；profile 级数据刷新紧随其后。
    replaySpaceScopedSettings({ profileId: targetProfileId, spaceId: targetSpace.id }, {
      force: true,
      shouldApply: () => selectionRevision === profileSelectionRevision
    })
    notifyProfileContextChanged(targetProfileId, targetSpace.id)

    // 5. 扩展 / 协议 / 网络等重活进入后台单飞链；最后一次切换永远赢。
    const generation = scheduleProfileSessionContext(targetProfileId, targetSpace.id)
    void waitForProfileSessionContext(generation)
      .then((current) => current
        ? slotCall.emit('profile.on-after-switch', { from: oldProfileId, to: targetProfileId })
        : undefined)
      .catch((e) => console.error('[main] profile.on-after-switch failed:', errorMessage(e)))

    return { ok: true, profile: activeProfile }
  }

  // ── 动态切换空间（对齐 RT spaces:set-using → setUsingSpace） ──
  // 空间归属于 profile：目标空间在其他 profile 时，先切 profile（换 session/扩展/UA），
  // 再切空间。同一 profile 内切空间只换标签会话，不重建 extension session。
  //
  // @param {object} [runtime] 目标窗口运行单元。多窗口下**空间是「按窗口」的**
  //   （对齐 RT `window.currentSpaceId`）：在 B 窗口切空间只应改变 B 的可见投影。
  //   profile 仍是应用级概念（同一时刻只有一个 activeProfile），因此跨 profile 的
  //   那一支保持全局语义不变。
  async function switchSpace(spaceId: string, profileId: string, runtime?: RuntimePort | null) {
    // 未显式给出窗口时用「IPC 发送方所属窗口」，再退回主窗口 ——
    // 这样渲染层发起的切换天然作用于自己那个窗口，不必逐个改 registrar 的调用点。
    // ⚠ currentOrNull()：不能用 current() 的「解析不到 → 主窗口」兜底，否则
    // 一次无法归属的切换会去改主窗口的可见投影（B 切空间却把 A 切了）。
    // 这里保留退主窗口作为**启动期/无 IPC 上下文**的合理兜底（单窗口语义：
    // 那时进程里确实只有主窗口），但只在真的解析不到时才走到。
    const rt = runtime && runtime.tabManager ? runtime : runtimeRegistry.currentOrNull()
    if (!rt || !rt.tabManager) {
      if (!runtimeRegistry.currentOrNull()) {
        console.warn('[main] switchSpace: 解析不到发起窗口 → 落到主窗口（仅单窗口/启动期语义）')
      }
      return switchSpaceOnRuntime(primaryWindow, spaceId, profileId)
    }
    return switchSpaceOnRuntime(rt, spaceId, profileId)
  }

  /**
   * 「切到当前 profile 的第 N 个空间」—— 空间快捷键（B4）的**唯一动作实现**。
   *
   * 靶子窗口的解析与 `switchSpace` 同一口径，但把"焦点窗口"放在"主窗口"之前：
   * 快捷键由主进程的按键拦截触发（不在 IPC 上下文里），此时用户意图显然是**他正在用的
   * 那个窗口** —— 沿用 IPC 兜底会在多窗口下切错窗口。
   *
   * @param {number} index 0-based。越界取**最后一个**（对齐 Ctrl+9 = 最后一个标签）。
   */
  function switchToSpaceIndex(index: number): void {
    const rt = runtimeRegistry.currentOrNull() || browserWindows.focused?.() || primaryWindow
    if (!rt || !rt.tabManager) return
    const current = runtimeCurrentSpace(rt)
    let spaces: SpaceRecord[] = []
    try { spaces = spaceService.list(current.profileId) || [] } catch (_) { return }
    if (!spaces.length) return
    // Ctrl+9 的语义是"最后一个"（与标签同口径）：越界一律收到末位。
    const at = index >= spaces.length ? spaces.length - 1 : Math.max(0, index)
    const target = spaces[at]
    if (!target || !target.id) return
    // 已经在这个空间 → 什么都不做。否则会白跑一次完整切换（重排标签、发事件、落盘）。
    if (String(target.id) === String(current.spaceId)) return
    switchSpace(target.id, target.profileId, rt)
  }

  /**
   * 空间快捷键的动作表（`space:1` … `space:9`）。
   *
   * 用工厂生成而不是手写 9 行：**下标语义只有一处**（第 N 项 = `i - 1`），
   * 手写时最容易出现"某一项错位一格"，而那种错位只在用户按到那一格时才被发现。
   */
  function buildSpaceKeybindingActions(): Record<string, () => void> {
    const out: Record<string, () => void> = {}
    for (let i = 1; i <= 9; i++) {
      out[`space:${i}`] = () => switchToSpaceIndex(i - 1)
    }
    return out
  }

  /** 在指定窗口上执行空间切换（编排本体；窗口已确定，不再做任何解析兜底）。 */
  async function switchSpaceOnRuntime(rt: RuntimePort, spaceId: string, profileId: string) {
    const rtSpace = rt.spaceRuntime
    const rtCurrent = rtSpace?.getCurrent?.() || { profileId: activeProfile?.id || 'default', spaceId: activeSpace?.id || 'default' }
    const target = spaceService.get(profileId, spaceId)
    if (!target) return { ok: false, reason: 'space not found' }

    /**
     * ⚠ 这里必须分成**两个**判据 —— 以前用一个 `sameProfile` 兼两件事，正是
     * 「切别的 profile 的空间有时没反应」的根因：
     *
     *   · `alreadyThere`      —— 「**本窗口**是否已经在目标空间」→ 只看本窗口自己的落点；
     *   · `sameActiveProfile` —— 「**全局** active profile 是否已是目标 profile」
     *     → 决定要不要换 session / 扩展 / 权限 / 下载那一整套。
     *
     * 旧写法拿**全局** `activeProfile.id` 去比目标 profile，又拿**本窗口**的
     * `rtCurrent.spaceId` 去比目标空间 id，再把两者 AND 起来当"已经在那儿了"：
     * 两个判据来源不同，一旦不同步（多窗口下是常态：profile 是应用级、空间是按窗口的），
     * 就会误判并**直接早退**。最典型的一例：两个 profile 都有同名的 `default` 空间 ——
     * 窗口停在 A/default、而全局 activeProfile 已是 B 时点 B/default，
     * 旧判据算出 `sameSpace = true` → 什么也没发生；用户必须先切到 A 的**另一个**空间
     * 把 activeProfile 拉回 A，再点 B/default 才生效（正是反馈里的现象）。
     */
    const targetProfileId = String(target.profileId || 'default')
    const windowProfileId = String(rtCurrent.profileId || activeProfile?.id || 'default')
    const globalProfileChanged = targetProfileId !== String(activeProfile?.id || 'default')
    const windowProfileChanged = targetProfileId !== windowProfileId
    const alreadyThere = !globalProfileChanged && !windowProfileChanged && target.id === rtCurrent.spaceId
    if (alreadyThere) {
      // 同格重入仍做一次轻量自愈：只重放空间级设置并补空会话，不重跑 profile 全套。
      replaySpaceScopedSettings(
        { profileId: targetProfileId, spaceId: target.id },
        { force: true, shouldApply: () => String(activeProfile?.id || 'default') === targetProfileId }
      )
      scheduleSpaceHydration(rt, target, nextSwitchRevision(rt))
      return { ok: true, space: target }
    }
    const revision = nextSwitchRevision(rt)
    const selectionRevision = ++profileSelectionRevision

    console.log('[main] switching space to:', targetProfileId, '/', target.id, 'profileChanged:', windowProfileChanged, 'globalChanged:', globalProfileChanged, 'window:', rt.ordinal)

    // 1. 旧空间会话延后串行保存；tabPort 仍钉死在切换前那一格，避免串档。
    const spaceSaveDir = sessionDirFor(rtCurrent.profileId, rtCurrent.spaceId)
    const savedSpace = { profileId: rtCurrent.profileId, spaceId: rtCurrent.spaceId }
    scheduleSpaceSessionSave(rt, savedSpace, spaceSaveDir)

    // 2. 先让 TabManager 读旧/写新，再同步组合根的 activeSpace。
    //    顺序不能反：提前 setCurrent 会让 TabManager 把目标误当成 prev，旧空间永不睡眠。
    rt.tabManager?.setCurrentSpace(targetProfileId, target.id)
    if (rt === primaryWindow) {
      activeSpace = target
      setActiveSpace(activeSpace)
      spaceRuntime.setCurrent({ profileId: targetProfileId, spaceId: target.id })
    }
    // 窗口投影完成后再提交全局身份：扩展加载 / 协议重绑 / 网络下发都不在点击链路等待。
    if (globalProfileChanged) commitProfileIdentity(targetProfileId)
    setTimeout(() => {
      if (selectionRevision !== profileSelectionRevision || !isSwitchCurrent(rt, revision)) return
      try { spaceService.setLastUsed(target.profileId, target.id) } catch (_) {}
    }, 16)

    // 3. 主题与其它按空间设置立刻切源并推给渲染层。显式 scope 防止只按 id 匹配到
    //    同名 default 空间 / 旧 profile；profile 变了时强制重放，即使值相同也刷新。
    replaySpaceScopedSettings(
      { profileId: targetProfileId, spaceId: target.id },
      {
        force: windowProfileChanged || globalProfileChanged,
        shouldApply: () => selectionRevision === profileSelectionRevision && isSwitchCurrent(rt, revision)
      }
    )

    // 4. 数据刷新只发生在「这个窗口真的换了 profile」时。全局 profile 已相同、
    //    只是窗口从别的 profile 切回来时也必须刷新，所以判据用窗口自己的 profile。
    if (windowProfileChanged) notifyProfileContextChanged(targetProfileId, target.id)

    // 5. 扩展 / 网络收尾后台执行；目标空间为空时，会话恢复也在首帧后开始。
    if (windowProfileChanged || globalProfileChanged) {
      scheduleProfileSessionContext(targetProfileId, target.id)
    }
    scheduleSpaceHydration(rt, target, revision)

    return { ok: true, space: target }
  }


  return {
    applyProfileContext,
    afterProfileContextChanged,
    buildSpaceKeybindingActions,
    ensureSpaceHasTab,
    ensureSpaceSessionOrTab,
    getSettingsSync: () => settingsSyncRef,
    replaySpaceScopedSettings,
    safeSpaceTabCount,
    setSettingsSync: (value: SettingsSync | null | undefined) => { settingsSyncRef = value || null },
    switchProfile,
    switchSpace,
    switchSpaceOnRuntime,
    switchToSpaceIndex
  }
}


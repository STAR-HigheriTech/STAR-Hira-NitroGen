/**
 * IPC · Password 域（S4-1）
 *
 * 密码后端管理、凭据增删查、自动填充浮层（多凭据菜单 + 保存提示卡）、生成密码。
 * 浮层编排的状态（发起页 sender、会话级去重集合、展示中凭据 key）是本注册器的
 * 私有闭包 —— 语义与拆分前一致（原来也是 registerCoreIpc 调用级作用域）。
 * 自 ipc-routes.js 原样搬入（Step 5，语义零改动）。
 */

import { BrowserWindow, dialog, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PasswordRuntimePort { layoutCoordinator?: MethodPort; tabManager?: MethodPort; win?: BrowserWindow }
interface RuntimeRegistryPort {
  provide(name: string, method: string, factory: (runtime: PasswordRuntimePort) => (...args: unknown[]) => unknown): unknown
}
interface PasswordOverlayControllerPort { hideTransient?: (...args: unknown[]) => unknown; generatePassword?: (...args: unknown[]) => unknown }
interface AutofillUnlockFlowPort {
  ensureUnlocked(options: { reason: string; hostname: string }): Promise<unknown>
  settle(request: unknown): Promise<unknown>
  cancelPending(options: { hide: boolean }): unknown
  isPending(): boolean
}
interface PasswordIpcContext {
  routes: IpcRoutes
  events: Record<string, string>
  schemas: IpcSchemas['passwords']
  passwordService: MethodPort
  layoutCoordinator: MethodPort
  tabManager: MethodPort
  passwordOverlayController?: PasswordOverlayControllerPort | null
  providerRegistry?: ProviderRegistryPort | null
  settingsService?: { get(key: string): unknown } | null
  isFeatureOn?(feature: string): boolean
  runtimeRegistry?: RuntimeRegistryPort | null
}

const { ownerWindowOf } = require('../window-runtime-registry.js') as { ownerWindowOf(webContents: WebContents): { id: number } | null | undefined }
const { installPasswordTool } = require('../password-tool-install') as {
  installPasswordTool(service: MethodPort, name: unknown): Promise<{ ok?: boolean; reason?: string; message?: string; path?: string }>
}
const { createAutofillUnlockFlow } = require('../password-autofill-unlock.js') as {
  createAutofillUnlockFlow(options: unknown): AutofillUnlockFlowPort
}
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs') as {
  PRIVACY_SETTING_KEYS: { passwordSavePrompt: string; formAutofill: string }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function senderOf(event: unknown): WebContents | null {
  if (!event || typeof event !== 'object' || !('sender' in event)) return null
  return (event as { sender?: WebContents }).sender || null
}

function isPasswordPageSender(event: unknown): boolean {
  try {
    const frame = (event as { senderFrame?: { url?: unknown; detached?: unknown } | null } | null)?.senderFrame
    if (!frame || frame.detached === true) return false
    const url = new URL(String(frame.url || ''))
    return url.protocol === 'hira:' && url.hostname === 'passwords'
  } catch (_) {
    return false
  }
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

export function registerPasswordIpc(
  typedMain: IpcTypedMain,
  { routes, events, schemas, passwordService, layoutCoordinator, tabManager, passwordOverlayController, providerRegistry, settingsService, isFeatureOn, runtimeRegistry }: PasswordIpcContext
): void {
  /**
   * 密码引擎是否还在（§10.4）。缺省视为可用 —— 与 feature-map 的 fail-open 口径一致。
   *
   * 为什么密码的两个"弹浮层"入口都要问这一句：浮层由**主进程主动推**给独立图层，
   * 与权限请求不同，网页那边并不等待；所以引擎一关，症状不是卡住而是
   * **弹出一个点了必然失败的浮层**（它的数据要经 `password.*` 能力取，那已被 blocked）。
   * 不弹，才是"功能真的消失"应有的样子。
   */
  const featureOn = typeof isFeatureOn === 'function' ? isFeatureOn : () => true
  if (!passwordService) return

  const invoke = createProviderInvoker(providerRegistry)
  // 读取设置里的隐私开关（settingsService 可能缺席 → 默认开启，保持既有行为）
  const settingEnabled = (key: string, fallback = true): boolean => {
    try { return settingsService ? !!settingsService.get(key) : fallback } catch (_) { return fallback }
  }

  typedMain.handle(routes.passwordBackends, {
    requestSchema: schemas.backends.request,
    responseSchema: schemas.backends.response,
    handler: async () => invoke('password.listBackends', () => passwordService.listBackends(), null)
  })

  typedMain.handle(routes.passwordSetActive, {
    requestSchema: schemas.setActive.request,
    responseSchema: schemas.setActive.response,
    handler: async (_e, req) => ({ ok: await invoke('password.setActiveBackend', () => passwordService.setActiveBackend(req.name), req) })
  })

  // 外部密码后端运行时动作（Bitwarden / 1Password：probe / unlock / sign-in / sync）。
  // 主密码只活在这一跳与域内调用栈里：不写日志、不回渲染层、不落盘；
  // 会话密钥由后端自己留在主进程内存，这里只回 `{ ok, reason, message }`。
  typedMain.handle(routes.passwordBackendAction, {
    requestSchema: schemas.backendAction.request,
    responseSchema: schemas.backendAction.response,
    handler: async (_e, req) => invoke(
      'password.backendAction',
      () => passwordService.backendAction(req.name, req.action, {
        password: req.password,
        clientId: req.clientId,
        clientSecret: req.clientSecret,
        email: req.email,
        secretKey: req.secretKey,
        address: req.address
      }),
      req
    )
  })

  /**
   * 安装外部 CLI：弹系统文件选择框 → 复制到 userData/tools/ → 立即重新探测。
   * 这是「不再让用户自己搬文件」的入口；mac 的 op 只发 .pkg，安装模式由
   * 后端 getStatus().installMode 决定（'download' 时打开官方下载页）。
   */
  typedMain.handle(routes.passwordInstallTool, {
    requestSchema: schemas.installTool.request,
    responseSchema: schemas.installTool.response,
    handler: async (_e, req) => {
      if (!featureOn('passwords')) return { ok: false, reason: 'feature-disabled' }
      const result = await installPasswordTool(passwordService, req.name)
      if (!result.ok || result.reason === 'download-opened') {
        return { ok: result.ok, reason: result.reason, message: result.message, path: result.path }
      }
      // 复制成功 ≠ 能跑（可能拿错平台的文件 / 缺依赖）——立刻探测一次，如实回报
      const probed = asRecord(await passwordService.backendAction(req.name, 'probe', {}))
      if (probed.ok === false) {
        return {
          ok: false,
          reason: String(probed.reason || 'probe-failed'),
          message: `文件已复制到工具目录，但 CLI 未能启动：${String(probed.message || '请确认下载的是当前系统版本。')}`,
          path: result.path
        }
      }
      return { ok: true, path: result.path }
    }
  })

  typedMain.handle(routes.passwordGetSuggestions, {
    requestSchema: schemas.getSuggestions.request,
    responseSchema: schemas.getSuggestions.response,
    // 先过「确保已解锁」闸门：锁定 / 未登录时弹卡等待用户，完成后原请求继续。
    // `load` 不打扰（页面刚打开就弹主密码框太侵入），只有用户交互路径才弹。
    handler: async (_e, req) => {
      if (featureOn('passwords')) {
        await unlockFlow.ensureUnlocked({ reason: req.reason || 'manual', hostname: req.hostname })
      }
      return invoke('password.getSuggestions', () => passwordService.getSuggestions(req.hostname), req)
    }
  })

  typedMain.handle(routes.passwordSave, {
    requestSchema: schemas.save.request,
    responseSchema: schemas.save.response,
    // 透传服务返回的 { ok, strength }（老调用只读 ok，additive）
    handler: async (_e, req) => invoke('password.saveCredential', () => passwordService.saveCredential(req), req)
  })

  typedMain.handle(routes.passwordDelete, {
    requestSchema: schemas.delete.request,
    responseSchema: schemas.delete.response,
    handler: async (e, req) => {
      if (!isPasswordPageSender(e)) return { ok: false }
      return { ok: await invoke('password.deleteCredential', () => passwordService.deleteCredential(req.id), req) }
    }
  })

  typedMain.handle(routes.passwordList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => invoke('password.listCredentials', () => passwordService.listCredentials(), null)
  })

  typedMain.handle(routes.passwordReveal, {
    requestSchema: schemas.reveal.request,
    responseSchema: schemas.reveal.response,
    handler: async (e, req) => {
      if (!isPasswordPageSender(e)) return { ok: false }
      const credential = await invoke('password.revealCredential', () => passwordService.revealCredential(req.id), req)
      return credential ? { ok: true, credential } : { ok: false }
    }
  })

  typedMain.handle(routes.passwordUpdate, {
    requestSchema: schemas.update.request,
    responseSchema: schemas.update.response,
    handler: async (e, req) => {
      if (!isPasswordPageSender(e)) return { ok: false }
      return { ok: await invoke('password.updateCredential', () => passwordService.updateCredential(req), req) }
    }
  })

  typedMain.handle(routes.passwordExport, {
    requestSchema: schemas.export.request,
    responseSchema: schemas.export.response,
    handler: async (e) => {
      if (!isPasswordPageSender(e)) return { ok: false, reason: 'forbidden' }
      const rows = await invoke('password.exportCredentials', () => passwordService.exportCredentials(), null)
      if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'empty' }
      const sender = senderOf(e)
      const owner = sender ? BrowserWindow.fromWebContents(sender) : null
      const date = new Date().toISOString().slice(0, 10)
      const options = {
        title: '导出密码',
        defaultPath: `HiraNG-Passwords-${date}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      }
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      const lines = ['"url","username","password"']
      for (const row of rows as Array<Record<string, unknown>>) {
        lines.push([csvCell(row.domain), csvCell(row.username), csvCell(row.password)].join(','))
      }
      await writeFile(result.filePath, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8')
      return { ok: true, count: rows.length }
    }
  })

  // 凭据 CSV 批量导入（F-0598）：
  // 页面只递交文件文本；表头识别 / 域名归一 / 去重 / 批量 upsert 全在域内完成。
  // 当前后端没有批量能力 → `unsupported: true`（如实上报，不假装导入了 0 条）。
  typedMain.handle(routes.passwordImportCsv, {
    requestSchema: schemas.importCsv.request,
    responseSchema: schemas.importCsv.response,
    handler: async (_e, req) => invoke(
      'password.importCredentials',
      () => passwordService.importCredentials(req.content, { profileId: req.profileId }),
      req
    )
  })

  // 密码体检（N8）：本地判定（常见弱密码 / 强度 / 重复使用），域不联网。
  // 明文只在域内流转、用完即弃 —— 渲染层拿到的只有 `{ id, domain, username, kinds }`。
  typedMain.handle(routes.passwordAudit, {
    requestSchema: schemas.audit.request,
    responseSchema: schemas.audit.response,
    handler: async () => invoke('password.auditCredentials', () => passwordService.auditCredentials(), null)
  })

  typedMain.handle(routes.passwordNeverSaveAdd, {
    requestSchema: schemas.neverSaveAdd.request,
    responseSchema: schemas.neverSaveAdd.response,
    handler: async (_e, req) => { await invoke('password.addNeverSave', () => passwordService.addNeverSave(req.hostname), req); return { ok: true } }
  })

  typedMain.handle(routes.passwordNeverSaveRemove, {
    requestSchema: schemas.neverSaveRemove.request,
    responseSchema: schemas.neverSaveRemove.response,
    handler: async (_e, req) => { await invoke('password.removeNeverSave', () => passwordService.removeNeverSave(req.hostname), req); return { ok: true } }
  })

  typedMain.handle(routes.passwordNeverSaveList, {
    requestSchema: schemas.neverSaveList.request,
    responseSchema: schemas.neverSaveList.response,
    handler: async () => invoke('password.listNeverSave', () => passwordService.getNeverSaveDomains(), null)
  })

  // ── 密码自动填充浮层：原生菜单窗口 + 保存提示卡 ──
  // 在独立的密码浮层 view 中展示多凭据菜单 / 保存提示，并把用户选择回传给“发起标签页”
  let pendingAutofillMenuSender: WebContents | null = null

  // 会话级去重：用户已对某条凭据做出决定（保存 / 暂不保存 / 永不保存）后，
  // 同一 hostname+username+password 在本次会话内不再提示；
  // 只有用户名或密码发生变化（key 不同）才会再次提示。
  const decidedCredentialKeys = new Set<string>()
  // 当前正在展示的保存提示卡对应凭据，展示期间重复上报直接忽略，
  // 避免“点一下别的输入框/按钮就反复弹”。
  let activeSaveKey = ''
  const credentialKey = (hostname: unknown, username: unknown, password: unknown): string =>
    `${stripWww(hostname)}\u0000${username || ''}\u0000${password || ''}`

  const sendPasswordOverlayEventTo = (lc: MethodPort | null | undefined, route: string, payload: unknown): void => {
    if (!lc) return
    // 密码浮层惰性：sendToPasswordOverlay 会在浮层尚未创建时先惰性创建 view
    // 并等 renderer 就绪（did-finish-load）后再发送 —— 避免「首个 show 事件
    // 打在空白 renderer 上丢失」。保留 getPasswordOverlayWebContents 退化路径
    // 以兼容仅注入 peek 的旧调用方 / 测试桩。
    if (typeof lc.sendToPasswordOverlay === 'function') {
      Promise.resolve(lc.sendToPasswordOverlay(`ngipc:event:${route}`, payload || {})).catch(() => {})
      return
    }
    const wc = lc.getPasswordOverlayWebContents ? lc.getPasswordOverlayWebContents() as WebContents | null : null
    if (wc && !wc.isDestroyed()) {
      wc.send(`ngipc:event:${route}`, payload || {})
    }
  }

  const sendPasswordOverlayEvent = (route: string, payload: unknown): void => sendPasswordOverlayEventTo(layoutCoordinator, route, payload)

  const stripWww = (hostname: unknown): string => { try { return String(hostname || '').replace(/^www\./, '') } catch (_) { return String(hostname || '') } }

  /**
   * 自动填充前的「确保已解锁 / 已登录」闸门（见 password-autofill-unlock.js）。
   *
   * 这是「外部密码库不可用」的核心修复点：后端锁定时不再静默返回空数组，
   * 而是先让浮层弹「解锁 / 登录」卡，用户完成后原请求自然继续。
   */
  const unlockFlow = createAutofillUnlockFlow({
    passwordService,
    // 事件名从契约表取，浮层协议只有一份真源（ipc-channels.mjs）。
    events,
    sendOverlayEvent: sendPasswordOverlayEvent,
    getWindowSize: () => {
      const win = (layoutCoordinator && layoutCoordinator.getWindow ? layoutCoordinator.getWindow() : null) as BrowserWindow | null
      if (!win || win.isDestroyed()) return [0, 0]
      try { return win.getContentSize() } catch (_) { return [0, 0] }
    }
  })

  /**
   * 收起某个窗口的**瞬态**密码浮层（多凭据菜单 / 解锁登录卡）。
   *
   * ⚠ 保存提示卡**不在**这里收：它是一条「等用户决定」的请求，刷新站点、页面跳转、
   * 切换标签、窗口失焦都不该替用户做决定。只有用户点按钮 / 点空白 / Esc 才结束它
   * （见 `passwordOverlayCommit` 的 save / save-dismiss / save-release 分支）。
   * 因此本函数不清 `activeSaveKey`，也不发 `overlayHidePasswordSave` ——
   * 旧实现两件事都做，导致「刷新时 pagehide 上报弹卡 → 紧接着 tab:loading 收卡」
   * 的一闪而过。
   *
   * @param {object|null} rt 目标窗口运行单元；省略 = 按 IPC 上下文解析（scoped 代理）。
   *
   * 为什么要显式传 rt：窗口生命周期事件（切标签 / 失焦 / 关闭）在主进程里调用，
   * 不在 IPC 上下文内，scoped 代理会一律回落到主窗口 —— 多窗口下就会去关另一个
   * 窗口的浮层。控制器在创建时也拿不到自己的运行单元，所以由注册表把
   * 「按窗口派生」的 hideTransient 注入到每个窗口的控制器上（见 runtimeRegistry.provide）。
   */
  function hideTransientPasswordOverlays(rt: PasswordRuntimePort | null): void {
    const lc = (rt && rt.layoutCoordinator) || layoutCoordinator
    /**
     * ⚠ 这是**切标签 / 窗口失焦**的高频路径，必须先判"到底有没有东西可收"。
     *
     * 旧实现无条件走 `sendToPasswordOverlay`，而那条通道是**惰性创建**语义
     * （浮层不存在就先建 view 再等 renderer 就绪）—— 于是用户第一次切标签就会
     * **凭空拉起一个密码浮层渲染进程**（几十 MB + 一次同步建视图），只为对它说
     * "隐藏"。之后每次切标签还要再发两条 IPC。
     *
     * 现在：浮层进程根本没建、也没有待处理的展示 → 直接返回，零创建、零 IPC。
     * 浮层确实存在时再发（`sendToPasswordOverlay` 此时只走"已有视图"那条路）。
     */
    const overlayWc = lc && typeof lc.getPasswordOverlayWebContents === 'function'
      ? lc.getPasswordOverlayWebContents() as WebContents | null
      : null
    const overlayAlive = !!(overlayWc && !overlayWc.isDestroyed())
    // 保存卡不算「待处理」：它不收，也就没有回执要给页面。
    const hadPending = !!(pendingAutofillMenuSender || unlockFlow.isPending())
    if (!overlayAlive && !hadPending) return

    // 通知发起页要在清空 sender 之前取：清空后就找不到"谁在展示"了。
    const s = senderForOverlayHidden(rt)
    pendingAutofillMenuSender = null
    // 挂起的「解锁 / 登录」必须一起取消，否则那条 getSuggestions 的 Promise
    // 会永久 pending（页面侧表现为钥匙按钮再也不响应）。
    unlockFlow.cancelPending({ hide: false })
    // 只有真展示过瞬态卡才发隐藏事件 —— 保存卡单独展示期间切标签/刷新不必白送两条 IPC。
    if (overlayAlive && hadPending) {
      sendPasswordOverlayEventTo(lc, events.overlayHidePasswordMenu, {})
      sendPasswordOverlayEventTo(lc, events.overlayHidePasswordUnlock, {})
    }
    // 通知发起页同步会话状态：preload 侧 menuOpen 仍为 true 时，下次点击输入框
    // 会走 dismiss 分支而非重新弹出（表现为"点两次才弹"）。
    // 只有**真的展示过**才需要这条回执 —— 否则每次切标签都往新标签的 preload 白送一条。
    // 跨文档导航场景 sender 可能已销毁 / 为空，静默跳过即可。
    if (hadPending && s && !s.isDestroyed()) {
      try { s.send(`ngipc:event:${events.passwordOverlayHidden}`, {}) } catch (_) {}
    }
  }

  /** 发起页 webContents：优先"当前展示浮层的请求方"，退化到目标窗口的活动标签页。 */
  function senderForOverlayHidden(rt: PasswordRuntimePort | null): WebContents | null {
    if (pendingAutofillMenuSender && !pendingAutofillMenuSender.isDestroyed()) {
      // 有显式窗口时，只回传给该窗口的页面（不同窗口的浮层互不影响）
      if (!rt || belongsToRuntime(pendingAutofillMenuSender, rt)) return pendingAutofillMenuSender
    }
    const tm = (rt && rt.tabManager) || tabManager
    const wc = tm && tm.getActiveWebContents ? tm.getActiveWebContents() as WebContents | null : null
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** webContents 是否属于该窗口运行单元（窗口已销毁 → false）。 */
  function belongsToRuntime(wc: WebContents, rt: PasswordRuntimePort): boolean {
    if (!rt || !rt.win || rt.win.isDestroyed()) return false
    const owner = ownerWindowOf(wc)
    return Boolean(owner && owner.id === rt.win.id)
  }

  // 把"收起瞬态浮层"暴露给外部（main.js 接 tab:loading / 切标签 / win blur 事件）。
  // 回调注入而非 import：ipc/ 模块保持纯注册器，不持有跨模块状态。
  //
  // 有按窗口注册表时走 `provide`：为**每个窗口**（含之后新开的）注入一份绑定到
  // 自身运行单元的实现；没有注册表（单窗口降级）时退回本窗口控制器上的直接赋值。
  // ⚠ 不能直接给 `passwordOverlayController` 赋值 —— 传入的是 scoped 代理，
  // 那个代理没有 set 陷阱，赋值只会落到它的空壳上而静默失效。
  if (runtimeRegistry && typeof runtimeRegistry.provide === 'function') {
    runtimeRegistry.provide('passwordOverlayController', 'hideTransient', (rt: PasswordRuntimePort) => () => hideTransientPasswordOverlays(rt))
    runtimeRegistry.provide('passwordOverlayController', 'generatePassword', (rt: PasswordRuntimePort) => (loc: unknown) => generatePassword(rt, loc))
  } else if (passwordOverlayController && typeof passwordOverlayController === 'object') {
    passwordOverlayController.hideTransient = () => hideTransientPasswordOverlays(null)
    passwordOverlayController.generatePassword = (loc) => generatePassword(null, loc)
  }

  // tab(页面内) → main：请求展示多凭据菜单
  typedMain.handle(routes.passwordAutofillMenu, {
    requestSchema: schemas.autofillMenu.request,
    responseSchema: schemas.autofillMenu.response,
    handler: async (e, req) => {
      // 遵守「表单自动填充」开关：关闭则不弹多凭据菜单
      if (!settingEnabled(PRIVACY_SETTING_KEYS.formAutofill, true)) return { ok: false }
      // 密码引擎被禁用 → 不弹（弹出来也点不动，见文件内 featureOn 的说明）
      if (!featureOn('passwords')) return { ok: false }
      pendingAutofillMenuSender = senderOf(e)
      // 页面内坐标 → overlay 窗口坐标（加上活动标签 view 的偏移）
      const offset = asRecord(layoutCoordinator.getActiveTabViewOffset
        ? layoutCoordinator.getActiveTabViewOffset()
        : null)
      let mx = Math.round((req.x || 0) + Number(offset.x || 0))
      let my = Math.round((req.y || 0) + Number(offset.y || 0))
      // 钳制在窗口内：菜单实际宽度可达 360 + 56(padding)，高度约 240 + 56(padding)，
      // 避免锚点靠右/靠底时超出被裁切。注意必须先“下移一点”再计算，
      // 否则 mx 是锚点左侧坐标，直接 min(mx, ww-360) 会过度左移。
      const win = (layoutCoordinator.getWindow ? layoutCoordinator.getWindow() : null) as BrowserWindow | null
      const MENU_W = 360
      const MENU_H = 240
      // 粗定位后交给浮层渲染进程用**实测尺寸**做最终钳制（避免右侧溢出）
      let winW = 0
      let winH = 0
      if (win && !win.isDestroyed()) {
        const [ww0, wh0] = win.getContentSize()
        winW = ww0 || 0
        winH = wh0 || 0
        if (ww0) mx = Math.max(8, Math.min(mx, ww0 - MENU_W - 28))
        if (wh0) my = Math.max(8, Math.min(my, wh0 - MENU_H - 28))
      }
      sendPasswordOverlayEvent(events.overlayShowPasswordMenu, {
        hostname: req.hostname,
        credentials: req.credentials || [],
        x: mx,
        y: my,
        windowWidth: winW,
        windowHeight: winH
      })
      return { ok: true }
    }
  })

  // tab(页面内) → main：上报捕获的凭据，展示保存提示卡
  typedMain.handle(routes.passwordCaptured, {
    requestSchema: schemas.captured.request,
    responseSchema: schemas.captured.response,
    handler: async (_e, req) => {
      // 遵守「询问是否保存密码」开关：关闭则不再弹出保存提示卡
      if (!settingEnabled(PRIVACY_SETTING_KEYS.passwordSavePrompt, true)) return { ok: false }
      // 密码引擎被禁用 → 不弹保存卡。放在**任何 invoke 之前**：既不弹，也不产生
      // 一串"能力不可用"的错误日志（那些错误会被读者误当成真故障）。
      if (!featureOn('passwords')) return { ok: false }
      const hostname = req.hostname
      const norm = stripWww(hostname)
      const key = credentialKey(hostname, req.username, req.password)

      // 1) 用户本次会话已对同一凭据做过决定（保存/暂不保存/永不保存）→ 不再提示
      if (decidedCredentialKeys.has(key)) {
        return { ok: false }
      }
      // 2) 永久“永不保存”域名
      const neverList = await invoke('password.listNeverSave', () => passwordService.getNeverSaveDomains(), null)
      if (Array.isArray(neverList) && neverList.some((d) => d === norm || d === hostname)) {
        return { ok: false }
      }
      // 3) 已保存到密码库的完全相同凭据 → 不再提示
      const creds = await invoke('password.getSuggestions', () => passwordService.getSuggestions(hostname), { hostname })
      if (Array.isArray(creds)) {
        const exists = creds.some((c) => c.username === req.username && c.password === req.password)
        if (exists) {
          decidedCredentialKeys.add(key)
          return { ok: false }
        }
      }
      // 4) 同一凭据的提示卡正在展示 → 忽略重复上报（防止点别的输入框/按钮反复触发）
      if (activeSaveKey === key) {
        return { ok: false }
      }
      activeSaveKey = key
      // 窗口级尺寸：保存卡固定右上角定位
      const win = (layoutCoordinator.getWindow ? layoutCoordinator.getWindow() : null) as BrowserWindow | null
      const [ww, wh] = win ? win.getContentSize() : [800, 600]
      // 只读后端（Bitwarden / 1Password）→ 保存卡必须明说"这条会进内置保险库"，
      // 否则用户会以为写进了自己的外部密码库。判定只认 listBackends 的 writable。
      let readOnlyBackend = false
      try {
        const list = passwordService.listBackends()
        const active = Array.isArray(list) ? list.find((item) => item && item.active) : null
        readOnlyBackend = Boolean(active && active.writable === false)
      } catch (_) {}
      sendPasswordOverlayEvent(events.overlayShowPasswordSave, {
        hostname,
        username: req.username,
        password: req.password,
        readOnlyBackend,
        windowWidth: ww || 800,
        windowHeight: wh || 600
      })
      return { ok: true }
    }
  })

  // overlay → main：多凭据菜单选中 / 保存提示卡操作回传
  typedMain.handle(routes.passwordOverlayCommit, {
    requestSchema: schemas.overlayCommit.request,
    responseSchema: schemas.overlayCommit.response,
    handler: async (_e, req) => {
      // 解锁 / 登录 / 取消：交给我们自己的自动填充闸门（它持有等待中的 Promise）
      if (req.kind === 'unlock' || req.kind === 'sign-in' || req.kind === 'unlock-cancel') {
        try {
          await unlockFlow.settle(req)
        } catch (error) {
          console.error('[password] 解锁流程失败:', error instanceof Error ? error.message : String(error))
        }
        return { ok: true }
      }
      if (req.kind === 'menu') {
        // 菜单选中 → 回传给发起标签页自动填充
        if (pendingAutofillMenuSender && !pendingAutofillMenuSender.isDestroyed()) {
          pendingAutofillMenuSender.send('ngipc:event:password:autofill-menu-select', {
            credential: req.credential || {}
          })
        }
        pendingAutofillMenuSender = null
        sendPasswordOverlayEvent(events.overlayHidePasswordMenu, {})
        return { ok: true }
      }
      if (req.kind === 'menu-cancel') {
        pendingAutofillMenuSender = null
        sendPasswordOverlayEvent(events.overlayHidePasswordMenu, {})
        return { ok: true }
      }
      if (req.kind === 'save' && req.hostname) {
        const action = req.action || 'later'
        // 无论保存 / 暂不保存 / 永不保存，都把“当前这条凭据”记入会话去重集合：
        // 同一用户名+同一密码不再提示；换新用户名或新密码（key 变化）才会再提示。
        decidedCredentialKeys.add(credentialKey(req.hostname, req.username, req.password))
        // 若用户在卡片里改过用户名/密码，把展示前上报的原始凭据也一并标记
        if (activeSaveKey) decidedCredentialKeys.add(activeSaveKey)
        activeSaveKey = ''
        if (action === 'save') {
          await invoke('password.saveCredential', () => passwordService.saveCredential({
            hostname: req.hostname,
            username: req.username || '',
            password: req.password || ''
          }), req)
        } else if (action === 'never' && req.hostname) {
          await invoke('password.addNeverSave', () => passwordService.addNeverSave(req.hostname), req)
        }
        sendPasswordOverlayEvent(events.overlayHidePasswordSave, {})
        return { ok: true }
      }
      // 保存卡被另一张卡（菜单 / 解锁卡）顶掉：只解除"正在展示"占位。
      // ⚠ 不能记入 decidedCredentialKeys —— 用户还没做决定，稍后同一凭据仍应提示；
      // 这与 save-dismiss（用户主动关闭 = 本次会话不再打扰）语义不同。
      if (req.kind === 'save-release') {
        activeSaveKey = ''
        return { ok: true }
      }
      // 点击空白/Esc 关闭保存卡但未做选择：同凭据本次会话也不再打扰
      if (req.kind === 'save-dismiss' && req.hostname) {
        decidedCredentialKeys.add(credentialKey(req.hostname, req.username, req.password))
        if (activeSaveKey) decidedCredentialKeys.add(activeSaveKey)
        activeSaveKey = ''
        sendPasswordOverlayEvent(events.overlayHidePasswordSave, {})
        return { ok: true }
      }
      return { ok: true }
    }
  })

  /**
   * 向窗口的活动标签页推送“生成密码”浮层。
   *
   * 两条入口共用这一个实现：页面内右键菜单等走 `password:generate` 路由（rt=null，
   * 按 IPC 上下文解析窗口），应用菜单「工具 → 生成密码」走注入到每个窗口控制器上的
   * `generatePassword`（rt=该窗口运行单元）。
   * 位置缺省为 (0,0) —— 浮层自己会做窗口内钳制。
   */
  function generatePassword(rt: PasswordRuntimePort | null, location: unknown): boolean {
    const loc = asRecord(location)
    const tm = (rt && rt.tabManager) || tabManager
    const wc = tm && tm.getActiveWebContents ? tm.getActiveWebContents() as WebContents | null : null
    if (!wc || wc.isDestroyed()) return false
    if (!featureOn('passwords')) return false
    wc.send('ngipc:event:' + events.generatePassword, {
      location: { x: Math.round(Number(loc.x) || 0), y: Math.round(Number(loc.y) || 0) }
    })
    return true
  }

  // 任意 renderer → main：向活动标签页推送“生成密码”
  typedMain.handle(routes.passwordGenerate, {
    requestSchema: schemas.generate.request,
    responseSchema: schemas.generate.response,
    handler: async (_e, req) => ({ ok: generatePassword(null, req) })
  })
}


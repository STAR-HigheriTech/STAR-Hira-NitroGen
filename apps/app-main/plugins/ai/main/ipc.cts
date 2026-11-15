/**
 * AI 引擎 · IPC 面（PART15 §9）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么全部在插件里注册
 * ══════════════════════════════════════════════════════════════════════
 * `ai:*` 这 21 条通道是**插件的能力**，不是内核的能力。注册在插件的 `enable()` 里，
 * 于是禁用插件 = 通道当场消失（渲染侧 `invoke` 直接 reject，而不是"调一个没人应的空壳"）。
 * 这正是 §5.2「零残留」在 IPC 层的兑现方式 —— 内核一行 `if (aiEnabled)` 都不需要。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 错误口径：**不抛，回 `{ ok:false, code }`**
 * ══════════════════════════════════════════════════════════════════════
 * 走 IPC 抛错只剩一段 message 字符串（Error 的自定义字段在结构化克隆里会丢），
 * 渲染层就没法区分"没配模型（该弹配置卡）"与"会话忙（该提示稍候）"。
 * 所以域错误一律转成响应体里的 `code`，只有**契约校验失败**（zod）才真的 reject ——
 * 那种错是调用方写错了，不该被 UI 当成可展示状态。
 */

const { createTypedIpcMain, ipcSchemas } = require('@hira-ng/infra-ipc')
const { IPC_ROUTES } = require('@hira-ng/shared-types/src/ipc-channels.mjs')

import type { AiEnginePort, UnknownRecord } from '../types'

interface AiIpcError extends Error { code?: string; fatal?: boolean }
interface AiIpcSchema { request?: unknown; response?: unknown }

function codeOf(err: unknown): string {
  if (!err) return 'AI_UNKNOWN'
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code
  return 'AI_ERROR'
}

/** 只有本域自己定义的 `AI_*` 错误码才允许把 message 原样回渲染层。 */
const DOMAIN_CODE = /^AI_[A-Z0-9_]+$/

/**
 * 对外（渲染层）的错误文案。
 *
 * 系统错误（ENOENT / SQLITE_* / net 错误）的 message 里会带**主进程的绝对路径**、
 * 数据库语句甚至密钥条目名 —— 面板是插件 UI，不该看到这些内部细节。
 * 域错误（`AI_*`）是我们自己写的给人看的话，照常透出。
 */
function publicMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' && DOMAIN_CODE.test(err.code)) {
    return String(('message' in err ? err.message : '') || err.code)
  }
  return 'AI 引擎内部错误'
}

/**
 * @param {{
 *   ipcMain: Electron.IpcMain,
 *   engine: ReturnType<import('./engine.cjs').createEngine>,
 *   logger?: {warn?: Function}
 * }} deps
 * @returns {() => void} disposer（逐条摘掉 handler）
 */
function registerAiIpc({ ipcMain, engine, authorize, logger = console }: {
  ipcMain: Electron.IpcMain
  engine: AiEnginePort
  authorize?: (event: unknown, route: string) => boolean | Promise<boolean>
  logger?: Pick<Console, 'warn'>
}): () => void {
  const typed = createTypedIpcMain(ipcMain, { authorize })
  const ai = ipcSchemas.ai
  /** 已注册的完整通道名 —— 停用时按名摘除（`removeHandler` 只认 channel）。 */
  const channels: string[] = []

  /**
   * 统一注册：`fn` 里抛出的域错误 → `{ ok:false, code, message }`。
   *
   * 三个例外照抛：`AI_BAD_REQUEST`（契约写错，本就不该发生）、以及任何
   * 明确标了 `fatal: true` 的错误（内部 bug —— 让渲染层看到 reject 好过被伪装成业务状态）。
   */
  function handle(
    route: string,
    schema: AiIpcSchema | undefined,
    fn: (event: Electron.IpcMainInvokeEvent, req: UnknownRecord) => unknown | Promise<unknown>
  ): void {
    const channel = typed.handle(route, {
      requestSchema: schema && schema.request,
      responseSchema: schema && schema.response,
      handler: async (event: Electron.IpcMainInvokeEvent, req: UnknownRecord) => {
        try {
          return await fn(event, req)
        } catch (e) {
          const error = e as AiIpcError
          if (error && error.fatal) throw error
          if (!error || !error.code || error.code === 'EP_SYNC_VIOLATION') {
            // 详细原因只进主进程日志（含堆栈），不回渲染层。
            logger.warn && logger.warn(`[ai] ${route} 失败：`, error?.stack || error?.message || error)
          }
          return { ok: false, code: codeOf(e), message: publicMessage(e) }
        }
      }
    })
    channels.push(String(channel))
  }

  // ── 状态 / 会话 ──────────────────────────────────────────────────
  handle(IPC_ROUTES.aiState, ai.state, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.state(req))
  // 共享界面状态（侧栏 / 独立窗口 / 内部页同一份，见 main/ui-state.cjs）
  handle(IPC_ROUTES.aiUiState, ai.uiState, () => engine.getUiState())
  handle(IPC_ROUTES.aiUiStateSet, ai.uiState, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.setUiState(req))
  handle(IPC_ROUTES.aiSessionList, ai.sessionList, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.listSessions(req))
  handle(IPC_ROUTES.aiSessionCreate, ai.sessionCreate, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.createSession(req))
  handle(IPC_ROUTES.aiSessionRename, ai.sessionRename, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.renameSession(req))
  handle(IPC_ROUTES.aiSessionDelete, ai.sessionDelete, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.deleteSession(req))
  handle(IPC_ROUTES.aiSessionMessages, ai.sessionMessages, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.messages(req))
  handle(IPC_ROUTES.aiSessionSearch, ai.sessionSearch, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.searchSessions(req))
  handle(IPC_ROUTES.aiSessionExport, ai.sessionExport, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.exportSession(req))
  handle(IPC_ROUTES.aiAuditExport, ai.auditExport, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.auditExport(req))

  // ── 回合 ────────────────────────────────────────────────────────
  handle(IPC_ROUTES.aiSend, ai.send, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.send(req))
  handle(IPC_ROUTES.aiSteer, ai.steer, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.steer(req))
  handle(IPC_ROUTES.aiRetry, ai.retry, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.retry(req))
  handle(IPC_ROUTES.aiStop, ai.stop, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.stop(req))

  // ── 审批 / 意图 / 上下文 ─────────────────────────────────────────
  handle(IPC_ROUTES.aiApproval, ai.approval, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.approval(req))
  handle(IPC_ROUTES.aiIntentInvoke, ai.intentInvoke, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.intentInvoke(req))
  handle(IPC_ROUTES.aiContextCapture, ai.contextCapture, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.capture(req))
  handle(IPC_ROUTES.aiContextCandidates, ai.contextCandidates, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.candidates(req))
  handle(IPC_ROUTES.aiContextReveal, ai.contextReveal, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.reveal(req))

  // ── 模型服务 / 模型 / 技能 ───────────────────────────────────────
  handle(IPC_ROUTES.aiProviderList, ai.providerList, () => engine.providers.list())
  handle(IPC_ROUTES.aiProviderSave, ai.providerSave, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.providers.save(req))
  handle(IPC_ROUTES.aiProviderRemove, ai.providerRemove, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.providers.remove(req))
  handle(IPC_ROUTES.aiProviderTest, ai.providerTest, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.providers.test(req))
  handle(IPC_ROUTES.aiModelUpsert, ai.modelUpsert, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.providers.upsertModel(req))
  handle(IPC_ROUTES.aiModelRemove, ai.modelRemove, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.providers.removeModel(req))
  handle(IPC_ROUTES.aiSkillList, ai.skillList, () => engine.skills.list())
  handle(IPC_ROUTES.aiSkillSave, ai.skillSave, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.skills.save(req))
  handle(IPC_ROUTES.aiSkillRemove, ai.skillRemove, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.skills.remove(req))
  handle(IPC_ROUTES.aiSkillSetEnabled, ai.skillSetEnabled, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.skills.setEnabled(req))
  handle(IPC_ROUTES.aiSkillExport, ai.skillExport, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.skills.exportFile(req))
  handle(IPC_ROUTES.aiSkillImport, ai.skillImport, () => engine.skills.importFile())
  handle(IPC_ROUTES.aiSkillRun, ai.skillRun, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.skills.run(req))

  // ── 用量 / 彻底移除 ──────────────────────────────────────────────
  handle(IPC_ROUTES.aiUsage, ai.usage, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.usage(req))
  handle(IPC_ROUTES.aiPurge, ai.purge, (_e: Electron.IpcMainInvokeEvent, req: UnknownRecord) => engine.purge(req))

  return function dispose() {
    for (const channel of channels) {
      try { ipcMain.removeHandler(channel) } catch (_) {}
    }
    channels.length = 0
  }
}

module.exports = { registerAiIpc }

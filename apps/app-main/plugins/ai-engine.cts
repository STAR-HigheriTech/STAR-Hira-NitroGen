/**
 * ai-engine —— AI 助手的**引擎插件**（PART15 §3 / §9）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它只做一件事：把「引擎」接到插件生命周期上
 * ══════════════════════════════════════════════════════════════════════
 *   install()          → 建表（幂等）+ 造引擎实例
 *   extensionPoints()  → 挂实现：db.schema.migration / ai.context.provider / 菜单 / 快捷键
 *   enable()           → 注册 21 条 `ai:*` 通道
 *   disable()          → 摘通道 + 停回合 + 释放审批与意图
 *
 * 界面**不在这里**：`panel-ai` 通过 IPC 契约与事件（`ai:stream` 等）跟它说话，
 * 面板可拆、引擎可留（禁用 panel-ai，历史与配置都还在；反之亦然）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么 install 里要自己建表
 * ══════════════════════════════════════════════════════════════════════
 * `db.schema.migration` 的批量补跑发生在「插件启动完成」之后
 * （main.js#runPluginMigrations）与「运行期启用插件」之后 —— 也就是说 `enable()`
 * 执行的那一刻，`ai_*` 这些表**可能还不存在**。等内核来建，插件的第一条查询就炸。
 * `runAiMigrations()` 全是 `CREATE TABLE IF NOT EXISTS`，先跑一遍完全幂等；
 * 内核随后再跑一次也不会重复记账（迁移 id 由 infra-db 记账表去重）。
 *
 * 顺带一个好处：`ai:purge`（彻底移除）在 DROP 之后也能立刻用同一个函数把空表建回来。
 */

const { AI_MIGRATIONS, runAiMigrations } = require('./ai/core/db.cjs')
const { createEngine } = require('./ai/main/engine.cjs')
const { registerAiIpc } = require('./ai/main/ipc.cjs')
const { aiSettingsSection } = require('./ai/main/settings-section.cjs')

import type { AiEnginePort, AiKernelPort, AiServicesPort, ExtensionPointPort, PanelCatalogEntry } from './ai/types'

interface AiEngineInstance extends AiEnginePort {
  extensions(): unknown[]
  intentExtensions(): unknown[]
  dispose(): void
}
interface AiEnginePluginContext {
  kernel?: AiKernelPort
  extensionPoints: ExtensionPointPort
  contributions?: unknown
  getDomainServices?(): AiServicesPort | null | undefined
  panelCatalog?: { list?(): unknown[] }
}
interface AiMigration { id: string }

/** 引擎实例（模块级单例：插件生命周期内只有一份，禁用后置空）。 */
let engine: AiEngineInstance | null = null
/** IPC 摘除器（registerAiIpc 返回）。 */
let disposeIpc: (() => void) | null = null

/**
 * 取（必要时创建）引擎实例。
 *
 * 幂等 + 懒建：`extensionPoints()` 与 `enable()` 谁先到都行，
 * 且热禁用后重新启用（install 不会再跑）也能重新造出来。
 */
function ensureEngine(ctx: AiEnginePluginContext): AiEngineInstance {
  if (engine) return engine
  const kernel = ctx && ctx.kernel
  if (!kernel) throw new Error('ai-engine 是内置插件，需要 kernel 端口（检查 manifest.trustLevel）')

  // 表可能还没建（见文件头）—— 幂等，跑就是了。
  runAiMigrations(kernel.sqlite)

  engine = createEngine({
    kernel,
    extensionPoints: ctx.extensionPoints,
    // 技能贡献注册表：`ai-skills-builtin` 等插件把 `contributes.skills` 登记到这里，
    // 引擎读取时实时合并（禁用插件即自动消失）。
    contributions: ctx.contributions,
    getDomainServices: ctx.getDomainServices,
    // 面板目录（插件贡献 + 保底集）：AI 的 panel_list / panel_control 靠它认出合法面板 id，
    // 目录随插件启停变化，所以传的是取值函数而不是快照。
    getPanels: () => {
      const catalog = ctx && ctx.panelCatalog
      if (!catalog || typeof catalog.list !== 'function') return []
      try { return (catalog.list() || []) as PanelCatalogEntry[] } catch (_) { return [] }
    },
    logger: console
  }) as AiEngineInstance
  return engine
}

module.exports = {
  install(ctx: AiEnginePluginContext) {
    ensureEngine(ctx)
  },

  /**
   * 插槽实现（官方插槽表已声明 id，这里只挂实现，不重复 define）。
   * `key` 只对「同一插槽挂多条」有意义；这里每条各自落在不同插槽上。
   */
  extensionPoints(ctx: AiEnginePluginContext) {
    const e = ensureEngine(ctx)
    return {
      provides: [],
      extends: [
        // 插件自己的建表迁移（内核在启动完成 / 运行期启用后各补跑一次）
        ...(AI_MIGRATIONS as AiMigration[]).map((migration: AiMigration) => ({
          to: 'db.schema.migration',
          key: migration.id,
          impl: () => migration
        })),
        // 设置页分区（描述符路线）：只放入口，真实配置在面板的设置抽屉里，
        // 避免「设置页一套表单、面板一套表单」两份实现漂移。
        { to: 'settings.section-renderer', key: 'ai/section', impl: () => aiSettingsSection() },
        // 上下文解析（页面正文延迟抓取，见 engine.cjs#hydrate）
        ...e.extensions(),
        // 右键菜单意图 + 两条快捷键
        ...e.intentExtensions()
      ]
    }
  },

  enable(ctx: AiEnginePluginContext) {
    const e = ensureEngine(ctx)
    const kernel = ctx.kernel
    if (!kernel) throw new Error('ai-engine 需要 kernel 端口')
    // 通道随「启用」出现、随「停用」消失 —— 这就是 IPC 层的零残留。
    disposeIpc = registerAiIpc({
      ipcMain: kernel.ipcMain,
      engine: e,
      authorize: (event: unknown) => kernel.isTrustedSender ? kernel.isTrustedSender(event) : false
    })
  },

  disable() {
    if (disposeIpc) {
      try { disposeIpc() } catch (_) {}
      disposeIpc = null
    }
    if (engine) {
      try { engine.dispose() } catch (_) {}
      engine = null
    }
  },

  /** 卸载：与 disable 同款收尾（数据默认保留，见 §5.2；彻底移除走 `ai:purge`）。 */
  uninstall() {
    module.exports.disable()
  }
}

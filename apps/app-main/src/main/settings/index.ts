/**
 * settings/index.ts — 设置特性模块（main process）唯一入口
 *
 * 这是 NG「解耦 / 模块化 / 插件化」的一个完整示例：设置这个横切特性被收拢成一个
 * 自包含目录，通过两个明确的接口对外：
 *   - createSettingsFeature({ settingsService, deps })  启动生效协调器（applier 链）
 *   - registerSettingsIpc(typedMain, ctx)               挂载 IPC 路由
 *
 * 目录布局：
 *   registry.ts        分区注册中心（UI 渲染契约，插件点）
 *   sync.ts            生效协调器（applier 链 + 广播）
 *   appliers/*         内置生效器（每项设置的主进程行为，一格一文件）
 *   ipc.js             路由
 *
 * 外部只 require 本文件，不直接依赖内部文件 —— 内部可自由重组而不影响调用方。
 */

import { createSettingsSync, matches, type SettingsSync, type SettingsServicePort } from './sync'
import { registerBuiltinAppliers } from './appliers'
import type { ApplierDependencies } from './appliers/types'

const { createSettingsRegistry, registerBuiltinSettingsSections, settingsRegistry } =
  require('./registry') as {
    createSettingsRegistry(options?: unknown): unknown
    registerBuiltinSettingsSections(registry: unknown, options?: unknown): unknown
    settingsRegistry: unknown
  }
const { registerSettingsIpc } = require('./ipc') as {
  registerSettingsIpc(typedMain: unknown, context: unknown): unknown
}

interface SettingsFeatureOptions {
  settingsService: SettingsServicePort
  deps?: ApplierDependencies
  send?: (route: string, payload: unknown, options?: { skipWebContentsId?: number }) => number
  runWithScope?: <T>(profileId: string, spaceId: string, task: () => T) => T
}

interface SettingsFeatureResult {
  sync: SettingsSync
  registry: unknown
}

/**
 * 启动设置生效链路：构建协调器 → 挂内置 applier → 订阅 → 全量应用一次。
 *
 * @param {{ settingsService:any, deps?:Object, send?:Function }} options
 * @returns {{ sync:any, registry:any }}
 */
export function createSettingsFeature({ settingsService, deps = {}, send, runWithScope }: SettingsFeatureOptions): SettingsFeatureResult {
  const sync = createSettingsSync({ settings: settingsService, send, runWithScope })
  registerBuiltinAppliers(sync, deps)
  sync.start()
  // 启动时把已持久化的设置推给所有 applier：否则上次退出时保存的设置
  // 要等到"下次再改一次"才生效。
  sync.applyAll()
  return { sync, registry: settingsRegistry }
}

export {
  registerSettingsIpc,
  createSettingsRegistry,
  registerBuiltinSettingsSections,
  settingsRegistry,
  createSettingsSync,
  registerBuiltinAppliers,
  matches,
  type SettingsSync,
  type SettingsServicePort
}

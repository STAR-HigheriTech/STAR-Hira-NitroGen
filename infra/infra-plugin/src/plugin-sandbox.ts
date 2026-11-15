/**
 * 插件权限沙箱 (Plugin Permission Sandbox)
 *
 * W20-6: 社区 Mod require('fs') 必须 throw。
 *
 * 4 级权限：
 *   - 'none'      : 无任何系统访问
 *   - 'ui'        : 仅 UI 相关（DOM, events）
 *   - 'network'   : UI + 网络请求
 *   - 'full'      : 全部（仅内置插件）
 *
 * 20 scope 组合：每个 scope 控制特定能力。
 *
 * 解耦：纯权限契约，不自行执行插件代码。社区代码由 apps 的独立宿主加载。
 */

import {
  PLUGIN_PERMISSION_LEVELS,
  type PluginPermissionLevel
} from '@hira-ng/shared-types/src/plugin-core'

export { PLUGIN_PERMISSION_LEVELS }
export type PermissionLevel = PluginPermissionLevel
export type CapabilityMap = Record<string, string | boolean>

/** 默认允许的模块（所有级别都可用） */
export const SAFE_MODULES = new Set<string>([
  'events', 'util', 'url', 'querystring', 'string_decoder'
])

/** 网络级别额外允许 */
export const NETWORK_MODULES = new Set<string>([
  'http', 'https', 'net', 'tls', 'zlib', 'stream'
])

/** 危险模块（任何级别都不允许社区 Mod 使用） */
export const DANGEROUS_MODULES = new Set<string>([
  'fs', 'child_process', 'os', 'cluster', 'worker_threads',
  'electron', 'original-fs', 'module', 'vm', 'process', 'inspector',
  'repl', 'trace_events', 'v8', 'wasi'
])

/** scope → 允许的能力映射 */
export const SCOPE_PERMISSIONS = {
  'storage:read':     { storage: 'read' },
  'storage:write':    { storage: 'write' },
  'tabs:read':        { tabs: 'read' },
  'tabs:modify':      { tabs: 'modify' },
  'bookmarks:read':   { bookmarks: 'read' },
  'bookmarks:write':  { bookmarks: 'write' },
  'history:read':     { history: 'read' },
  'downloads:read':   { downloads: 'read' },
  'downloads:write':  { downloads: 'write' },
  'webRequest':       { webRequest: true },
  'notifications':    { notifications: true },
  'contextMenus':     { contextMenus: true },
  'cookies':          { cookies: true },
  'permissions':      { permissions: true },
  'settings:read':    { settings: 'read' },
  'settings:write':   { settings: 'write' },
  'clipboard':        { clipboard: true },
  'nativeMessaging':  { nativeMessaging: true },
  'proxy':            { proxy: true },
  'tts':              { tts: true },
  // ── PART18 开放世界：外壳 / 内容 / 自动化 / AI ──────────────────────
  'ui:chrome':        { ui: 'chrome' },
  'ui:overlay':       { ui: 'overlay' },
  'content:read':     { content: 'read' },
  'content:modify':   { content: 'modify' },
  'panels:manage':    { panels: 'manage' },
  'actions:run':      { actions: 'run' },
  'ai:invoke':        { ai: 'invoke' },
  'browser:control':  { browser: 'control' },
  'pages:manage':     { pages: 'manage' }
} as const satisfies Record<string, CapabilityMap>

/**
 * scope → **给用户看的中文名**。
 *
 * 为什么放在这里而不是渲染层：scope 的权威定义就在本文件（上面那张表）。
 * 授权弹窗要给用户看的是"这个插件想读你的浏览历史"，而不是 `history:read` ——
 * 但翻译表若抄一份到 UI 包，两边就一定会漂移（加 scope 时只改一处是常态）。
 * 所以表跟着权威定义走，经 `describe().requestedPermissionLabels` 下发。
 */
export type PluginScope = keyof typeof SCOPE_PERMISSIONS

export const SCOPE_LABELS = {
  'storage:read': '读取本地存储',
  'storage:write': '写入本地存储',
  'tabs:read': '读取标签页',
  'tabs:modify': '修改标签页',
  'bookmarks:read': '读取书签',
  'bookmarks:write': '修改书签',
  'history:read': '读取浏览历史',
  'downloads:read': '读取下载记录',
  'downloads:write': '修改下载记录',
  webRequest: '拦截与改写网络请求',
  notifications: '发送系统通知',
  contextMenus: '添加右键菜单项',
  cookies: '读写网站 Cookie',
  permissions: '读取与修改站点权限',
  'settings:read': '读取浏览器设置',
  'settings:write': '修改浏览器设置',
  clipboard: '读写剪贴板',
  nativeMessaging: '与本地程序通信',
  proxy: '修改代理设置',
  tts: '使用语音合成',
  'ui:chrome': '自定义工具栏 / 标签 / 菜单外观',
  'ui:overlay': '新增浮层与浮层内容',
  'content:read': '读取网页内容',
  'content:modify': '修改网页内容',
  'panels:manage': '管理面板（显示 / 隐藏 / 重排 / 改标题）',
  'actions:run': '执行浏览器操作与自动化',
  'ai:invoke': '调用 AI 能力',
  'browser:control': '控制浏览器（标签 / 窗口 / 导航）',
  'pages:manage': '管理内部页面'
} as const satisfies Record<PluginScope, string>

/**
 * 检查 scope 是否在插件声明的权限范围内。
 * @param {string[]} declaredScopes
 * @param {string} requiredScope
 * @returns {boolean}
 */
export function hasScope(declaredScopes: readonly string[], requiredScope: string): boolean {
  return declaredScopes.includes(requiredScope)
}

/**
 * 获取插件被授予的能力集合。
 * @param {string[]} scopes
 * @returns {object} 能力映射
 */
export function getGrantedCapabilities(scopes: readonly PluginScope[]): CapabilityMap {
  const caps: CapabilityMap = {}
  for (const scope of scopes) {
    const perm: CapabilityMap | undefined = SCOPE_PERMISSIONS[scope]
    if (perm) Object.assign(caps, perm)
  }
  return caps
}

/**
 * 验证插件声明的 scopes 是否合法。
 * @param {string[]} scopes
 * @returns {{ valid: boolean, invalid: string[] }}
 */
export function validateScopes(scopes: readonly string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((scope) => !(scope in SCOPE_PERMISSIONS))
  return { valid: invalid.length === 0, invalid }
}

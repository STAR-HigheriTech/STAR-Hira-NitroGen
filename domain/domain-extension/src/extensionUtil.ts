/** Pure extension manifest, permission, matching, localization, and presentation rules. */

import { BYTE_UNITS } from '@hira-ng/shared-types/src/format-size.mjs'
import { MANIFEST_PERMISSION_KEYS } from '@hira-ng/shared-types/src/permission-labels.mjs'
import { isHttpProtocol, isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type {
  ExtensionInspectView,
  ExtensionManifest,
  InspectSources,
  LocaleMessages
} from './types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function idOf(manifest: unknown): string {
  if (!isRecord(manifest)) return ''
  const raw = manifest.id
  if (typeof raw === 'string' && raw.trim()) return raw

  const hostPermissions = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions.filter((permission): permission is string => (
        typeof permission === 'string' && !!permission.trim()
      ))
    : []
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  const seed = hostPermissions[0] || name
  return seed ? stableHash(seed).toString(16).padStart(12, '0').slice(0, 12) : ''
}

export function validateVersionString(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parts = value.trim().split('.')
  return parts.length === 3 && parts.every((part) => /^\d+$/.test(part))
}

export function normalizedVersion(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parts = value.trim().split('.')
  if (parts.length < 1 || parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) return ''
  while (parts.length < 3) parts.push('0')
  return parts.join('.')
}

export function isValidManifest(manifest: unknown): manifest is ExtensionManifest {
  if (!isRecord(manifest)) return false
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return false
  return manifest.manifest_version === 2 || manifest.manifest_version === 3
}

export function manifestVersion(manifest: unknown): number {
  if (!isRecord(manifest)) return 0
  return manifest.manifest_version === 2 || manifest.manifest_version === 3
    ? manifest.manifest_version
    : 0
}

export function collectPermissions(manifest: unknown): string[] {
  if (!isRecord(manifest)) return []
  const seen = new Set<string>()
  const permissions: string[] = []
  for (const key of MANIFEST_PERMISSION_KEYS as readonly string[]) {
    const values = manifest[key]
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (typeof value !== 'string' || !value || seen.has(value)) continue
      seen.add(value)
      permissions.push(value)
    }
  }
  return permissions
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  tabs: '标签页',
  activetab: '活动标签页',
  tabgroups: '标签分组',
  sessions: '最近关闭的标签页',
  windows: '窗口',
  toptabs: '标签页',
  storage: '存储',
  unlimitedstorage: '无限存储',
  cookies: 'Cookie',
  history: '历史记录',
  bookmarks: '书签',
  readinglist: '阅读清单',
  downloads: '下载',
  'downloads.open': '打开已下载的文件',
  favicon: '网站图标',
  topsites: '新标签页',
  browsingdata: '浏览数据',
  contentsettings: '内容设置',
  privacy: '隐私设置',
  webrequest: '网络请求',
  webrequestblocking: '拦截网络请求',
  declarativenetrequest: '拦截网络请求',
  declarativenetrequestfeedback: '网络请求调试信息',
  declarativenetrequestwithhostaccess: '拦截网络请求',
  proxy: '代理设置',
  webnavigation: '浏览导航',
  mdns: '局域网设备发现',
  nativemessaging: '与本机程序通信',
  scripting: '脚本注入',
  userscripts: '用户脚本',
  debugger: '调试浏览器',
  management: '扩展管理',
  notifications: '通知',
  geolocation: '地理位置',
  clipboardread: '剪贴板读取',
  clipboardwrite: '剪贴板写入',
  contextmenus: '右键菜单',
  alarms: '定时任务',
  idle: '空闲状态',
  power: '电源状态',
  fontsettings: '字体设置',
  tts: '朗读文字',
  ttsengine: '语音朗读引擎',
  identity: '登录身份',
  'identity.email': '你的邮箱地址',
  gcm: '接收推送消息',
  desktopcapture: '屏幕共享',
  pagecapture: '保存网页',
  tabcapture: '捕获标签页内容',
  printerprovider: '打印提供程序',
  printing: '打印',
  search: '搜索设置',
  'system.cpu': 'CPU 信息',
  'system.memory': '内存信息',
  'system.storage': '存储设备信息',
  'system.display': '显示器信息',
  'system.network': '网络信息',
  audiocapture: '录音',
  videocapture: '拍摄视频',
  hid: 'HID 设备',
  serial: '串行设备',
  usb: 'USB 设备',
  bluetooth: '蓝牙设备',
  bluetoothdevices: '蓝牙设备',
  filesystem: '文件系统',
  filesystemprovider: '文件管理器',
  documentscan: '扫描文档',
  'enterprise.deviceattributes': '设备信息',
  'enterprise.networkingattributes': '网络信息',
  'enterprise.platformkeys': '企业证书与密钥',
  'enterprise.hardwareplatform': '硬件平台信息',
  'accessibilityfeatures.read': '读取无障碍功能',
  'accessibilityfeatures.modify': '修改无障碍功能',
  offscreen: '后台运行',
  sidepanel: '侧边栏',
  declarativecontent: '声明式内容规则',
  input: '输入法'
})

const PERMISSION_FALLBACK_PREFIX = '其它权限'
const ALL_URLS_LABEL = '读取你在所有网站上的数据'
const HOST_PATTERN_LABEL = '读取你在指定网站上的数据'

export function isHostPermission(permission: unknown): boolean {
  if (typeof permission !== 'string' || !permission) return false
  return permission === '<all_urls>' || permission.includes('://') || permission.startsWith('*')
}

export interface TranslatePermissionOptions {
  fallback?: string
}

export function translatePermissionName(permission: unknown, options: TranslatePermissionOptions = {}): string {
  const raw = typeof permission === 'string' ? permission : ''
  const fallback = options.fallback ?? raw
  if (!raw) return fallback
  if (raw === '<all_urls>') return ALL_URLS_LABEL
  if (isHostPermission(raw)) return `${HOST_PATTERN_LABEL}（${raw}）`
  const mapped = PERMISSION_LABELS[raw.toLowerCase()]
  return mapped || (fallback === raw ? `${PERMISSION_FALLBACK_PREFIX}（${raw}）` : fallback)
}

export function translatePermissionNames(permissions: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(permissions)) return []
  const seen = new Set<string>()
  const labels: string[] = []
  for (const permission of permissions) {
    const label = translatePermissionName(permission)
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

export function matchHostPattern(pattern: unknown, url: unknown): boolean {
  if (typeof pattern !== 'string' || typeof url !== 'string' || !pattern || !url) return false
  if (pattern === '<all_urls>') return isHttpUrl(url)

  const target = url.split('#')[0].split('?')[0]
  if (!/^[a-z]+:\/\//i.test(target)) return false
  const schemeMatch = target.match(/^([a-z]+):\/\//i)
  if (!schemeMatch) return false

  const scheme = schemeMatch[1].toLowerCase()
  const rest = target.slice(schemeMatch[0].length)
  const match = /^([a-z*]+\*?):\/\/([^/]*)\/(.*)$/.exec(pattern)
  if (!match) return false

  const [, patternScheme, patternHost, patternPath] = match
  if (patternScheme === '*' || patternScheme === '*/*') {
    if (!isHttpProtocol(`${scheme}:`)) return false
  } else if (patternScheme.toLowerCase() !== scheme) {
    return false
  }

  return matchHostPart(patternHost, rest) && matchPath(patternPath, rest)
}

function matchHostPart(patternHost: string, rest: string): boolean {
  const slashIndex = rest.indexOf('/')
  const targetHost = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
  if (patternHost === '*') return true
  if (patternHost.startsWith('*.')) {
    const body = patternHost.slice(2)
    return targetHost === body || targetHost.endsWith(`.${body}`)
  }
  return targetHost === patternHost
}

function matchPath(patternPath: string, rest: string): boolean {
  const slashIndex = rest.indexOf('/')
  const targetPath = slashIndex === -1 ? '' : rest.slice(slashIndex)
  const normalized = patternPath === '' ? '/*' : `/${patternPath}`
  const segments = normalized.split('*')
  let offset = 0

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (index === 0) {
      if (!targetPath.startsWith(segment, offset)) return false
      offset += segment.length
      if (segments.length === 1 && targetPath !== segment) return false
      continue
    }
    if (!segment) continue
    const found = targetPath.indexOf(segment, offset)
    if (found === -1) return false
    offset = found + segment.length
  }
  return true
}

export function sortPermissions(permissions: readonly unknown[] | null | undefined, order: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(permissions)) return []
  const rank = new Map<string, number>()
  for (const [index, permission] of (Array.isArray(order) ? order : []).entries()) {
    rank.set(permission, index)
  }
  return permissions
    .filter((permission): permission is string => typeof permission === 'string')
    .slice()
    .sort((left, right) => {
      const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER
      return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank
    })
}

export function contentScriptTargets(manifest: unknown): string[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.content_scripts)) return []
  const seen = new Set<string>()
  const targets: string[] = []
  for (const script of manifest.content_scripts) {
    if (!isRecord(script) || !Array.isArray(script.matches)) continue
    for (const target of script.matches) {
      if (typeof target !== 'string' || !target || seen.has(target)) continue
      seen.add(target)
      targets.push(target)
    }
  }
  return targets
}

export function extensionLabel(manifest: unknown, fallback = ''): string {
  if (isRecord(manifest) && typeof manifest.name === 'string' && manifest.name.trim()) {
    return manifest.name.trim()
  }
  return typeof fallback === 'string' ? fallback.trim() : ''
}

export function isManifestV3(manifest: unknown): boolean {
  return isRecord(manifest) && manifest.manifest_version === 3
}

const MESSAGE_TEMPLATE_PATTERN = /^__MSG_(.+?)__$/

export function messageKeyOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = MESSAGE_TEMPLATE_PATTERN.exec(value)
  return match ? match[1] : ''
}

export const UI_LOCALE_PREFERENCE = Object.freeze(['zh_CN', 'zh', 'zh_TW']) as readonly string[]

export function localeChainOf(defaultLocale?: unknown, preferred: readonly string[] = UI_LOCALE_PREFERENCE): string[] {
  const chain: string[] = []
  const append = (value: unknown): void => {
    if (typeof value !== 'string') return
    const locale = value.trim()
    if (locale && !chain.includes(locale)) chain.push(locale)
  }
  for (const locale of Array.isArray(preferred) ? preferred : []) append(locale)
  append(defaultLocale)
  return chain
}

export function localizedManifestText(raw: unknown, messagesByLocale: LocaleMessages | null | undefined, chain: readonly unknown[] | null | undefined): string {
  const fallback = typeof raw === 'string' ? raw : ''
  const key = messageKeyOf(raw)
  if (!key || !isRecord(messagesByLocale)) return fallback
  for (const locale of Array.isArray(chain) ? chain : []) {
    if (typeof locale !== 'string') continue
    const table = messagesByLocale[locale]
    const entry = table && isRecord(table) ? table[key] : null
    const message = entry && isRecord(entry) ? entry.message : null
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

export const INSPECT_VIEW_LABELS = Object.freeze({
  'background-page': '背景页',
  'service-worker': 'Service Worker'
})

function extensionUrlPrefix(extensionId: string): string {
  return `chrome-extension://${extensionId}/`
}

export function extensionIdOfUrl(url: unknown): string {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'chrome-extension:' ? parsed.hostname : ''
  } catch {
    return ''
  }
}

export function buildInspectViews(extensionId: unknown, sources?: InspectSources | null): ExtensionInspectView[] {
  const id = typeof extensionId === 'string' ? extensionId.trim() : ''
  if (!id) return []

  const input = isRecord(sources) ? sources : {}
  const prefix = extensionUrlPrefix(id)
  const belongsToExtension = (url: unknown): url is string => typeof url === 'string' && url.startsWith(prefix)
  const seen = new Set<string>()
  const views: ExtensionInspectView[] = []

  const pushView = (view: ExtensionInspectView): void => {
    const key = `${view.target}\u0001${view.url}`
    if (seen.has(key)) return
    seen.add(key)
    views.push(view)
  }

  for (const background of Array.isArray(input.backgrounds) ? input.backgrounds : []) {
    if (!isRecord(background) || !belongsToExtension(background.url)) continue
    pushView({
      target: 'background-page',
      label: INSPECT_VIEW_LABELS['background-page'],
      url: background.url,
      inspectable: true,
      note: ''
    })
  }

  for (const worker of Array.isArray(input.serviceWorkers) ? input.serviceWorkers : []) {
    if (!isRecord(worker)) continue
    const scope = belongsToExtension(worker.scope) ? worker.scope : ''
    const scriptUrl = belongsToExtension(worker.scriptUrl) ? worker.scriptUrl : ''
    if (!scope && !scriptUrl) continue
    pushView({
      target: 'service-worker',
      label: INSPECT_VIEW_LABELS['service-worker'],
      url: scriptUrl || scope,
      inspectable: false,
      note: 'Electron 未提供扩展后台 Service Worker 的开发者工具，只能显示其脚本地址'
    })
  }

  return views
}

const SIZE_UNITS = BYTE_UNITS as readonly string[]

export function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${SIZE_UNITS[unit]}`
}

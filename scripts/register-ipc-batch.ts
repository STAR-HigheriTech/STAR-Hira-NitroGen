// 一次性生成脚本：把 IPC_ROUTES（invoke）与 IPC_EVENTS（push）映射到各 category 空槽，
// 复用 register-function-points.cjs 的录入管线落地 catalog+tracker。
import * as fs from 'node:fs'
import * as path from 'node:path'

interface CatalogFunction {
  id: string
}

interface CatalogSegment {
  category: string
  range: string
}

interface CatalogFile {
  functions: CatalogFunction[]
  segments: CatalogSegment[]
}

type TrackerFile = Record<string, unknown>

interface CategoryRule {
  prefix: string
  category: string
}

interface IpcBatchEntry {
  id: string
  name: string
  category: string
  source: string
  ng: { kind: string; channel: string }
  status: 'covered'
  tests: string[]
}

const root = path.resolve(__dirname, '..')
const catalogPath = path.join(root, '.hira-ai', 'l1-functions.json')
const trackerPath = path.join(root, '.hira-ai', 'l1-coverage-tracker.json')

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogFile
const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8')) as TrackerFile

// 读取 IPC 通道（ESM）
const src = fs.readFileSync(path.join(root, 'packages', 'shared-types', 'src', 'ipc-channels.mjs'), 'utf8')

// 域名前缀 → category 映射（与 segments 对齐）
const CHANNEL_CATEGORY: readonly CategoryRule[] = [
  { prefix: 'bookmark:', category: 'bookmark' },
  { prefix: 'history:', category: 'history' },
  { prefix: 'download:', category: 'download' },
  { prefix: 'extension:', category: 'extensions' },
  { prefix: 'adblocker:', category: 'extensions' },
  { prefix: 'keybindings:', category: 'keybindings' },
  { prefix: 'password:', category: 'password' },
  { prefix: 'permission:', category: 'permission' },
  { prefix: 'search:', category: 'search' },
  { prefix: 'game:', category: 'external-games' },
  { prefix: 'settings:', category: 'settings' },
  { prefix: 'profile:', category: 'profile' },
  { prefix: 'tab:', category: 'tabs' },
  { prefix: 'omnibox:', category: 'search' }
]

function categoryOf(channel: string): string | null {
  for (const c of CHANNEL_CATEGORY) {
    if (channel.startsWith(c.prefix)) return c.category
  }
  return null // UI/overlay/layout/window/nav 等归入未映射（不占 F-00..F-11 槽位）
}

function parseTable(name: string): string[] {
  const re = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`)
  const m = src.match(re)
  if (!m) throw new Error(`table ${name} not found`)
  const body = m[1]
  const out = []
  for (const line of body.split('\n')) {
    const mm = line.match(/^\s*\w+\s*:\s*'([^']+)'/)
    if (mm) out.push(mm[1])
  }
  return out
}

const routes = parseTable('IPC_ROUTES')
const events = parseTable('IPC_EVENTS')

// 按 category 收集 catalog 已用 id，找出空槽（catalog 未出现的 F- 开头 id）
const used = new Set(catalog.functions.map((f) => f.id))

// 用 segment.range（如 "F-0001-F-0099"）精确判断 id 归属 category
function categoryOfId(id: string): string | null {
  for (const seg of catalog.segments) {
    const bounds = seg.range.match(/F-\d+/g)
    if (!bounds || bounds.length < 2) continue
    const [lo, hi] = bounds
    if (id.localeCompare(lo) >= 0 && id.localeCompare(hi) <= 0) return seg.category
  }
  return null
}

// 收集每个 category 可用空槽 id（按数值升序）
const availableByCategory: Record<string, string[]> = {}
for (const id of Object.keys(tracker).sort((a, b) => a.localeCompare(b))) {
  if (used.has(id)) continue
  const cat = categoryOfId(id)
  if (!cat) continue
  ;(availableByCategory[cat] = availableByCategory[cat] || []).push(id)
}

// 为每个可映射 channel 分配空槽
const batch: IpcBatchEntry[] = []
const assigned = new Set<string>()
const push = (channel: string, category: string, kind: string, source: string): void => {
  const pool = availableByCategory[category] || []
  const slot = pool.find((id) => !assigned.has(id))
  if (!slot) { console.warn(`no slot left for ${channel} (${category})`); return }
  assigned.add(slot)
  batch.push({
    id: slot,
    name: `IPC ${channel}`,
    category,
    source,
    ng: { kind, channel },
    status: 'covered',
    tests: ['packages/shared-types/src/ipc-channels.test.ts']
  })
}

const ipcHandlersBase = 'apps/app-main/src/main/ipc'
// routes: channel -> handler file 的粗略映射（按域名前缀决定 source 归属文件）
const routeFile = (ch: string): string => {
  if (ch.startsWith('bookmark:')) return ipcHandlersBase + '/bookmarks.js'
  if (ch.startsWith('history:')) return ipcHandlersBase + '/history.js'
  if (ch.startsWith('download:')) return ipcHandlersBase + '/downloads.js'
  if (ch.startsWith('extension:') || ch.startsWith('adblocker:')) return ipcHandlersBase + '/extensions.js'
  if (ch.startsWith('keybindings:')) return ipcHandlersBase + '/keybindings.js'
  if (ch.startsWith('password:')) return ipcHandlersBase + '/passwords.js'
  if (ch.startsWith('permission:')) return ipcHandlersBase + '/permissions.js'
  if (ch.startsWith('search:')) return ipcHandlersBase + '/search.js'
  if (ch.startsWith('profile:')) return ipcHandlersBase + '/profile.js'
  if (ch.startsWith('tab:') || ch.startsWith('nav:')) return ipcHandlersBase + '/tabs.js'
  if (ch.startsWith('settings:')) return ipcHandlersBase + '/settings/ipc.js'
  return ipcHandlersBase + '/provider-bridge.js'
}

const seenRoute = new Set<string>()
for (const ch of routes) {
  const cat = categoryOf(ch)
  if (!cat) continue
  if (seenRoute.has(ch)) continue
  seenRoute.add(ch)
  push(ch, cat, 'ipc', routeFile(ch))
}
for (const ch of events) {
  // events 也登记为 ipc 通道（channel 为事件名）
  const cat = categoryOf(ch)
  if (!cat) continue
  push(ch, cat, 'ipc', routeFile(ch))
}

// 写入 .batch.json 供 register-function-points.cjs 消费
fs.writeFileSync(path.join(root, '.hira-ai', '.ipc-batch.json'), JSON.stringify(batch, null, 2))
const byCategory = batch.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.category] = (counts[entry.category] ?? 0) + 1
  return counts
}, {})
console.log(JSON.stringify({ routes: routes.length, events: events.length, registered: batch.length, byCategory }, null, 2))

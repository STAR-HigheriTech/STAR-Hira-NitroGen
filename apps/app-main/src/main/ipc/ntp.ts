import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
/**
 * ipc/ntp.ts — NTP 快速拨号域路由（自包含，不在 ipc-routes.ts 里散布）
 *
 * 数据落到设置键 `app.speed_dial`（数组 [{id,title,url}]），
 * 由主进程 domain-settings 统一读写持久化 —— NTP 页面本身不碰 storage。
 * 业务极薄：list/add/remove/rename 都是对同一个数组的纯函数变换，
 * 因此适合作为 settings 之上的一个薄服务层，无需另起 domain 子包。
 */

interface SpeedDialSite { id: string; title: string; url: string }
interface NtpSettingsPort { get(key: string): unknown; set(key: string, value: unknown, originId?: number): unknown }
interface NtpIpcContext { routes: IpcRoutes; schemas: IpcSchemas['ntp']; settingsService: NtpSettingsPort; providerRegistry?: unknown }

function senderId(event: unknown): number {
  if (!event || typeof event !== 'object' || !('sender' in event)) return 0
  const sender = (event as { sender?: { id?: unknown } }).sender
  return typeof sender?.id === 'number' ? sender.id : 0
}

function isSite(value: unknown): value is SpeedDialSite {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && typeof row.title === 'string' && typeof row.url === 'string'
}

// 首次使用（从未存过 app.speed_dial）时填充的默认站点集。
// 用户增删后随即持久化；即便删空为 [] 也不再回填（尊重用户意图）。
const DEFAULT_SPEED_DIAL: SpeedDialSite[] = [
  { id: 's_zhihu', title: '知乎', url: 'https://www.zhihu.com' },
  { id: 's_bilibili', title: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 's_weibo', title: '微博', url: 'https://weibo.com' },
  { id: 's_github', title: 'GitHub', url: 'https://github.com' },
  { id: 's_stackoverflow', title: 'Stack Overflow', url: 'https://stackoverflow.com' },
  { id: 's_baidu', title: '百度', url: 'https://www.baidu.com' },
  { id: 's_bing', title: 'Bing', url: 'https://www.bing.com' },
  { id: 's_douban', title: '豆瓣', url: 'https://www.douban.com' },
  { id: 's_youtube', title: 'YouTube', url: 'https://www.youtube.com' },
  { id: 's_taobao', title: '淘宝', url: 'https://www.taobao.com' }
]

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, settingsService:any, providerRegistry?:any }} ctx
 */
export function registerNtpIpc(typedMain: IpcTypedMain, ctx: NtpIpcContext): void {
  const { routes, schemas, settingsService, providerRegistry } = ctx
  if (!typedMain || !settingsService) return
  const { createProviderInvoker } = require('./provider-bridge.js') as {
    createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown, context?: unknown) => T | Promise<T>
  }
  const invoke = createProviderInvoker(providerRegistry)

  const KEY = 'app.speed_dial'
  // 读取已存站点；仅当从未存过（get 返回 undefined，不是空数组）时返回默认集。
  // readSites 只读不改；真正写字面默认集的动作由 list handler 首拉时完成。
  const peekSites = (): SpeedDialSite[] | undefined => {
    try {
      const v = settingsService.get(KEY)
      return Array.isArray(v) ? v.filter(isSite) : undefined
    } catch (_) { return undefined }
  }
  const readSites = (): SpeedDialSite[] => peekSites() || []
  const writeSites = (sites: SpeedDialSite[], originId: number): unknown => settingsService.set(KEY, sites, originId)
  const genId = (): string => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  typedMain.handle(routes.ntpListSites, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: (e) => invoke('ntp.list-sites', () => {
      const originId = senderId(e)
      // 首拉且从未配置过 → 一次性落默认集并持久化（用户以后增删即覆盖，删空不回填）
      if (peekSites() === undefined) writeSites(DEFAULT_SPEED_DIAL.slice(), originId)
      return readSites()
    }, {}, { senderId: senderId(e) })
  })

  typedMain.handle(routes.ntpAddSite, {
    requestSchema: schemas.add.request,
    responseSchema: schemas.add.response,
    handler: (e, req) => {
      const originId = senderId(e)
      return invoke('ntp.add-site', () => {
        const title = String(req.title || '').trim() || String(req.url || '').trim()
        const url = String(req.url || '').trim()
        if (!url) return { ok: false, id: '' }
        const id = genId()
        const sites = readSites().concat([{ id, title, url }])
        writeSites(sites, originId)
        return { ok: true, id }
      }, req, { senderId: originId })
    }
  })

  typedMain.handle(routes.ntpRemoveSite, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: (e, req) => {
      const originId = senderId(e)
      return invoke('ntp.remove-site', () => {
        const sites = readSites().filter((s) => s.id !== req.id)
        writeSites(sites, originId)
        return { ok: true }
      }, req, { senderId: originId })
    }
  })

  typedMain.handle(routes.ntpRenameSite, {
    requestSchema: schemas.rename.request,
    responseSchema: schemas.rename.response,
    handler: (e, req) => {
      const originId = senderId(e)
      return invoke('ntp.rename-site', () => {
        const title = String(req.title || '').trim()
        const sites = readSites().map((s) => (s.id === req.id && title ? { ...s, title } : s))
        writeSites(sites, originId)
        return { ok: true }
      }, req, { senderId: originId })
    }
  })
}


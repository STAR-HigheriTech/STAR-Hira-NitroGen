/**
 * IPC · Cookie 域（TypeScript）
 *
 * 渲染层永远拿不到 Session 对象：本文件是 `session.cookies` 的唯一出口，
 * 只暴露「列 / 单删 / 全清」三件事。会话经 `getSession()` 端口注入 ——
 * 因此本域不认识 profile / space 领域，切换 profile 后自动作用于新会话。
 *
 * 与浏览数据域（browsing-data）的分工：本域管 cookie 明细，那域管整类数据一键清空。
 */

interface CookieLike {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  expirationDate?: number
}

interface SessionLike {
  cookies: {
    get(filter: { domain?: string; url?: string }): Promise<CookieLike[]>
    remove(url: string, name: string): Promise<void>
  }
  clearStorageData(options: { storages: string[] }): Promise<void>
}

import type { IpcSchemas, IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['cookies']
  getSession?: () => SessionLike | null
}

/** Electron 的 Cookie 是带方法的对象，必须转成纯对象才能过 IPC 的结构化克隆。 */
function toPlain(cookie: CookieLike) {
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain),
    path: String(cookie.path),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    session: Boolean(cookie.session),
    // session cookie 没有过期时间：显式给 null，避免 IPC 里出现 undefined 被丢弃
    expirationDate: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : null
  }
}

/**
 * Cookie 数据面的窄端口 —— IPC 路由与 AI 工具（cookies_list / cookie_remove / cookies_clear）
 * 共用同一套「怎么取、怎么删、怎么清」。
 *
 * 不给 AI 侧单开一条 session 通道：`session.cookies` 的形状（filter 语义、remove 需要
 * url+name 而不是 domain）是这一域的知识，散到两处就一定会有一处用错。
 */
export function createCookiePort(getSession: () => SessionLike | null) {
  return {
    /** @param filter 按 url 或 domain 过滤；都不给 = 全部 */
    async list(filter: { domain?: string; url?: string } = {}) {
      const session = getSession()
      if (!session) return []
      const query = filter.url
        ? { url: String(filter.url) }
        : filter.domain ? { domain: String(filter.domain) } : {}
      const list = await session.cookies.get(query)
      return list.map(toPlain)
    },
    async remove(url: string, name: string) {
      const session = getSession()
      if (!session) return { ok: false }
      await session.cookies.remove(String(url), String(name))
      return { ok: true }
    },
    async clear() {
      const session = getSession()
      if (!session) return { ok: false }
      // Electron 没有「清空全部 cookie」的单次 API；clearStorageData 的 cookies 桶
      // 就是它，比逐条 remove 少 N 次往返，且能一并清掉 HttpOnly 之外的存储。
      await session.clearStorageData({ storages: ['cookies'] })
      return { ok: true }
    }
  }
}

export function registerCookieIpc(typedMain: IpcTypedMain, { routes, schemas, getSession }: Deps): void {
  if (!routes?.cookieList || !schemas?.list || !getSession) return

  const jar = createCookiePort(() => (getSession ? getSession() : null))

  typedMain.handle(routes.cookieList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => {
      const domain = req && req.domain ? String(req.domain) : undefined
      return { cookies: await jar.list(domain ? { domain } : {}) }
    }
  })

  typedMain.handle(routes.cookieRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => jar.remove(req.url, req.name)
  })

  typedMain.handle(routes.cookieClear, {
    requestSchema: schemas.clear.request,
    responseSchema: schemas.clear.response,
    handler: async () => jar.clear()
  })
}


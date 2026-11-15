/**
 * `hira-pwa://` 特权协议 —— **已安装应用的图标资产**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（而不是给渲染层绝对路径 / data URL）
 * ══════════════════════════════════════════════════════════════════
 *  · 渲染层拿不到 `<userData>/profiles/...` 下的文件（file:// 被 CSP 与沙箱挡住）；
 *  · data URL 会让同一张 512px 图标在每个列表项里重复编码，列表一长就是几 MB 的 IPC；
 *  · URL 让 Chromium 自己缓存，图标换了只需要换 URL（更新时 appId 不变，但资产变了）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么 URL 必须带 `?p=<profileId>`
 * ══════════════════════════════════════════════════════════════════
 * 协议 handler 没有 sender 上下文，`runtimeRegistry` 解析不到当前 profile；
 * 显式带参是唯一无歧义的做法。目录拼接**只走 paths.assetPath**（唯一拼接点），
 * 本文件不出现任何 path.join —— 这是"路径规则只有一处"的硬约束。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全边界
 * ══════════════════════════════════════════════════════════════════
 *  · appId 必须匹配 `^pwa-[a-f0-9]{16}$`；
 *  · 文件名只在白名单（4 个图标）里；
 *  · 两层校验都通过后仍由 paths.assetPath 再做一次越界检查；
 *  · 只发图片 MIME，`Cache-Control: no-cache`（图标随更新变化，不能让旧图粘住）。
 */

const fs = require('node:fs/promises')
import type { Session } from 'electron'
import type { createPwaPaths } from './pwa/paths'

const { APP_ID_RE, SERVABLE_FILES, FILE_MIME } = require('./pwa/paths')

const PWA_SCHEME = 'hira-pwa'

// 特权注册不在这里 —— 见 `scheme-privileges.js`（全库唯一一次
// `registerSchemesAsPrivileged`；分散调用会互相覆盖）。

/**
 * 构造处理器。
 * @param {{ paths: ReturnType<typeof import('./pwa/paths').createPwaPaths>,
 *           logger?: { warn?: Function } }} options
 * @returns {(request: Request) => Promise<Response>}
 */
type PwaPaths = ReturnType<typeof createPwaPaths>

interface PwaProtocolOptions {
  paths: PwaPaths
  logger?: { warn?: (...args: unknown[]) => void }
}

function createPwaProtocolHandler(options: PwaProtocolOptions) {
  const { paths, logger = console } = options
  if (!paths) throw new TypeError('createPwaProtocolHandler 需要 paths')

  return async function handlePwaAsset(request: Request): Promise<Response> {
    let url
    try {
      url = new URL(request.url)
    } catch (_) {
      return new Response('Bad request', { status: 400 })
    }

    const appId = String(url.hostname || '').toLowerCase()
    if (!APP_ID_RE.test(appId)) return new Response('Bad request', { status: 400 })

    let file = ''
    try {
      file = decodeURIComponent(String(url.pathname || '').replace(/^\/+/, ''))
    } catch (_) {
      return new Response('Bad request', { status: 400 })
    }
    if (!SERVABLE_FILES.includes(file)) {
      if (logger && logger.warn) logger.warn('[pwa-protocol] 拒绝非白名单文件：', file)
      return new Response('Forbidden', { status: 403 })
    }

    const profileId = url.searchParams.get('p') || 'default'
    let abs
    try {
      abs = paths.assetPath(profileId, appId, file)
    } catch (e) {
      logger.warn?.('[pwa-protocol] 路径校验失败：', e instanceof Error ? e.message : e)
      return new Response('Forbidden', { status: 403 })
    }

    let data
    try {
      data = await fs.readFile(abs)
    } catch (_) {
      return new Response('Not Found', { status: 404 })
    }

    return new Response(data, {
      headers: {
        'Content-Type': FILE_MIME[file] || 'application/octet-stream',
        // 图标 URL 的 appId 不变、内容会随更新变化 → 必须每次回源。
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  }
}

/** 已经挂过 handler 的 session（幂等：同一个会话重复注册会抛「already registered」）。 */
const _registeredSessions = new WeakSet()

/**
 * 挂到默认 session（或指定 session）。
 * @param {{ paths: PwaPaths, session?: Session, logger?: object }} options
 */
function registerPwaProtocol(options: PwaProtocolOptions & { session?: Session }) {
  const handler = createPwaProtocolHandler(options)
  const targetSession = options.session || null
  if (targetSession) {
    if (_registeredSessions.has(targetSession)) return handler
    _registeredSessions.add(targetSession)
  }
  const target = targetSession ? targetSession.protocol : require('electron').protocol
  target.handle(PWA_SCHEME, handler)
  return handler
}

module.exports = {
  PWA_SCHEME,
  registerPwaProtocol,
  createPwaProtocolHandler
}

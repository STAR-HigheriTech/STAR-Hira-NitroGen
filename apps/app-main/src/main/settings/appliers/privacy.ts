import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { Session } from 'electron'

interface DntRequestDetails {
  requestHeaders?: Record<string, string>
}

type DntCallback = (response: { requestHeaders: Record<string, string> }) => void
type DntHook = (details: DntRequestDetails, callback: DntCallback) => void

// @ts-check
/**
 * settings/appliers/privacy.js — 隐私相关生效器
 *
 * Do Not Track：为每个请求加 `DNT: 1` 头。
 *
 * ★性能铁律（对齐 HiraRT：RT 全站零 webRequest 钩子）★
 * `session.webRequest.onBeforeSendHeaders` 是**逐请求阻塞**的：页面里
 * HTML/CSS/JS/图片/字体/XHR 的每一个资源请求，都必须先同步往返主进程
 * listener（拷贝 headers、遍历 key、回调）才允许发出 → 串行化延迟叠加，
 * 整页加载"跟 IE 一样慢"。
 *
 * 所以本钩子**绝不在启动时无条件安装**：只在 `privacy.do_not_track === true`
 * 时安装，关掉时立即用 `onBeforeSendHeaders(null)` 拆除。默认关闭 →
 * 零逐请求开销，与 RT 的"无钩子"模型完全一致。
 *
 * 同一 session 只能有一个 listener（后注册覆盖先注册），因此这里只维护
 * 一个钩子，并跟踪它挂在哪个 session 上（切 profile 时 session 会变）。
 *
 * @param {{ getSession?: () => any }} deps
 */
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')

function createDoNotTrackApplier(deps: ApplierDependencies = {}): SettingsApplier {
  let hookedSession: Session | null = null
  let hook: DntHook | null = null

  const removeHook = () => {
    if (hookedSession && hook && hookedSession.webRequest) {
      try {
        hookedSession.webRequest.onBeforeSendHeaders(null)
      } catch (e) {
        console.error('[settings] remove DNT hook failed:', errorMessage(e))
      }
    }
    hookedSession = null
    hook = null
  }

  const installHook = (session: Session): void => {
    hook = (details, callback) => {
      const headers = Object.assign({}, details.requestHeaders || {})
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'dnt') delete headers[k]
      }
      headers.DNT = '1'
      callback({ requestHeaders: headers })
    }
    session.webRequest.onBeforeSendHeaders(hook as Parameters<typeof session.webRequest.onBeforeSendHeaders>[0])
    hookedSession = session
  }

  return {
    id: 'privacy-do-not-track',
    keys: [PRIVACY_SETTING_KEYS.doNotTrack],
    apply({ settings }) {
      const session = typeof deps.getSession === 'function' ? deps.getSession() : null
      if (!session || !session.webRequest) return

      const enabled = !!settings.get(PRIVACY_SETTING_KEYS.doNotTrack)

      // session 变了（切 profile）→ 先把旧 session 上的钩子拆掉
      if (hookedSession && hookedSession !== session) removeHook()

      if (enabled) {
        if (!hookedSession) {
          try {
            installHook(session)
          } catch (e) {
            console.error('[settings] install DNT hook failed:', errorMessage(e))
          }
        }
      } else {
        // 关闭：确保不留任何 listener —— 默认路径必须零开销
        removeHook()
      }
    }
  }
}

export { createDoNotTrackApplier }

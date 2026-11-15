import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { WebContents } from 'electron'

type FingerprintConfig = Record<string, unknown> | null

// @ts-check
/**
 * settings/appliers/fingerprint.js —— 浏览器指纹伪装的**注入生效器**
 *
 * 设置项 `privacy.fingerprint`（按空间隔离）：
 *   · `null`      = 关闭（把页面里的活配置清空，钩子自动回落原生行为）
 *   · 指纹对象    = 开启（归一化后编译成主世界脚本下发）
 *
 * 注入时机有两道，缺一不可：
 *   1. `did-start-navigation`（主框架、非同文档）—— 与遗留项目
 *      `main/viewManager.js` 的时机一致，尽量赶在页面脚本之前；
 *   2. `dom-ready` —— 导航提交后的**可靠**时机（第 1 步可能落在旧文档上）。
 * 脚本自身幂等：同一 document 只装一次钩子，后续注入只更新
 * `window.__hiraFp`，所以"开着页面改设置"也不会重复包装原型链。
 *
 * 端口安全降级：无 tabManager / 无 onWebContentsCreated 时什么都不做，
 * 绝不让一次设置变更打断主进程。
 *
 * @param {{ tabManager?: any, onWebContentsCreated?: (fn:(wc:any)=>void)=>void }} deps
 */

const {
  FINGERPRINT_SETTING_KEY,
  normalizeFingerprint,
  buildFingerprintScript,
  generateFingerprint
} = require('@hira-ng/shared-types/src/fingerprint.mjs') as {
  FINGERPRINT_SETTING_KEY: string
  normalizeFingerprint(value: unknown): FingerprintConfig
  buildFingerprintScript(config: FingerprintConfig): string
  generateFingerprint(): unknown
}
const { registerRecordGenerator } = require('../record-generators') as {
  registerRecordGenerator(name: string, generator: () => unknown): void
}

function createFingerprintApplier(deps: ApplierDependencies = {}): SettingsApplier {
  /** 最近一次应用的指纹（null = 关闭）；never undefined，便于区分"还没应用过" */
  let current: FingerprintConfig = null
  let subscribed = false
  /** 已挂过导航监听的 webContents（WeakSet：随对象回收，不需手工清理） */
  const attached = new WeakSet()

  // 设置页「随机生成」走通用 record 路由 → 由本模块提供指纹生成器。
  // 幂等：重复注册只是覆盖同一个函数引用。
  registerRecordGenerator('fingerprint', generateFingerprint)

  /** 当前存活的标签页 webContents（遍历失败 → 空数组，绝不抛）。 */
  function tabWebContentsList(): WebContents[] {
    const tm = deps.tabManager
    const out: WebContents[] = []
    if (!tm || typeof tm.list !== 'function' || typeof tm.getWebContents !== 'function') return out
    try {
      for (const t of tm.list()) {
        const wc = tm.getWebContents(t.tabId)
        if (!wc) continue
        if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue
        out.push(wc)
      }
    } catch (_) {}
    return out
  }

  /** 向单个 webContents 下发当前配置（关闭时下发的是"清空"脚本）。 */
  function inject(wc: WebContents | null | undefined): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
    if (typeof wc.executeJavaScript !== 'function') return
    let code: string
    try {
      code = buildFingerprintScript(current)
    } catch (_) {
      return
    }
    try {
      const p = wc.executeJavaScript(code, true)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch (_) {}
  }

  /** 给一个标签挂上两条注入时机（每个 webContents 只挂一次），并立即补一次。 */
  function attach(wc: WebContents | null | undefined): void {
    if (!wc) return
    if (attached.has(wc)) {
      inject(wc)
      return
    }
    attached.add(wc)
    try {
      wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        // 兼容两种事件签名：位置参数 / details 对象
        if (isInPlace === true) return
        if (isMainFrame === false) return
        inject(wc)
      })
      wc.on('dom-ready', () => inject(wc))
    } catch (_) {}
    inject(wc)
  }

  /** 只订阅一次：之后新建的标签也带上同一份配置。 */
  function ensureSubscribed() {
    if (subscribed) return
    const tm = deps.tabManager
    if (tm && typeof tm.on === 'function') {
      subscribed = true
      try {
        tm.on('tab:webcontents-ready', ({ webContents }) => attach(webContents))
      } catch (_) {}
      return
    }
    // 降级：没有 tabManager 时用应用级 web-contents-created（只认标签型 webContents）
    if (typeof deps.onWebContentsCreated === 'function') {
      subscribed = true
      try {
        deps.onWebContentsCreated((wc) => {
          let type = ''
          try { type = typeof wc.getType === 'function' ? wc.getType() : '' } catch (_) {}
          if (type !== 'webview' && type !== 'browserView') return
          attach(wc)
        })
      } catch (_) {}
    }
  }

  return {
    id: 'privacy-fingerprint',
    keys: [FINGERPRINT_SETTING_KEY],
    apply({ value, settings }) {
      // value === undefined 有两种来源：启动全量应用（key:''）与切空间重放缺失；
      // 两种情况都该回读当前空间的真值，而不是把值当成"关闭"。
      const raw = value === undefined ? settings.get(FINGERPRINT_SETTING_KEY) : value
      current = normalizeFingerprint(raw)
      ensureSubscribed()
      for (const wc of tabWebContentsList()) attach(wc)
      return true
    }
  }
}

export { createFingerprintApplier }

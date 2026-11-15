/**
 * 导入适配器**注册表** —— 把用户给的一坨东西变成一串 `otpauth://` 链接。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它在这一层做什么、不做什么
 * ══════════════════════════════════════════════════════════════════════
 *   · 做：识别各家导出格式 → 转成**标准 `otpauth://` 链接**。
 *     放在**渲染层**——纯数据搬运，不需要任何密码学库，于是 otpauth 不进渲染包。
 *   · 不做：解析链接、校验密钥、加密落库。那些在主进程，且**只做一次**
 *     （永不信任渲染层的解析结果）。所以这里产出的链接哪怕有偏差，
 *     主进程也会挡住并逐条报因。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 「新增一家」= 加一个文件 + 在这里加一行
 * ══════════════════════════════════════════════════════════════════════
 * 顺序即优先级，而**兜底的 otpauthTextAdapter 必须最后** ——
 * 它几乎能匹配任何东西（只要含 `otpauth://`），放前面会把别家全吃掉。
 *
 * 判别式（match）必须**足够严格**：抢错格式的表现是"导入成功但条目全错"，
 * 比认不出来更糟 —— 用户会以为自己的密钥就是这样。
 */

import { aegisAdapter } from './aegis.js'
import { andotpAdapter } from './andotp.js'
import { bitwardenAdapter } from './bitwarden.js'
import { googleMigrationAdapter } from './google-migration.js'
import { onePasswordAdapter } from './onepassword.js'
import { otpauthTextAdapter } from './otpauth-uri.js'
import { twofasAdapter } from './twofas.js'

/** 顺序即优先级；兜底永远最后。 */
const ADAPTERS = [
  // ── 各家专有 JSON（判别式最严，放最前）──
  onePasswordAdapter,
  bitwardenAdapter,
  aegisAdapter,
  twofasAdapter,
  andotpAdapter,
  // ── 专有非 JSON 格式 ──
  googleMigrationAdapter,
  // ── 兜底：任何含 otpauth:// 的文本 ──
  otpauthTextAdapter
]

/** 支持哪些格式（面板上照这个列出来，避免文案与实现漂移）。 */
export function listImportFormats() {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label }))
}

/** 尽量把输入解析成 JSON（不是 JSON 就返回 null，那是合法情况）。 */
function tryParseJson(text: unknown): Record<string, unknown> | null {
  const s = String(text || '').trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch (_) {
    return null
  }
}

/**
 * 识别并转换。
 *
 * 语义是"**尽力而为 + 说清楚**"：
 *   · 命中某一家的判别式但解不出来 → 直接返回**那一家的原因**
 *     （比"认不出格式"有用得多：前者说"该怎么做"，后者只是说"这是什么"）；
 *   · 命中判别式但产出为空 → 继续试下一个，避免把整次导入堵死；
 *   · 全都不中 → 明确说清"认不出"，并提示可以粘贴什么。
 *
 * @param {string} text
 * @returns {{ ok: true, format: string, label: string, uris: string[], warnings: string[] }
 *         | { ok: false, format?: string, label?: string, reason: string }}
 */
export function decodeImport(text: string) : { ok: true, format: string, label: string, uris: string[], warnings: string[] }
        | { ok: false, format?: string, label?: string, reason: string } {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, reason: '没有可导入的内容' }
  const json = tryParseJson(raw)

  let matchedWithoutOutput = null
  for (const adapter of ADAPTERS) {
    let matched = false
    try {
      matched = adapter.match(raw, json) === true
    } catch (_) {
      matched = false
    }
    if (!matched) continue

    let res: { ok?: boolean; uris?: unknown; warnings?: unknown; reason?: string } | null = null
    try {
      res = adapter.decode(raw, json)
    } catch (e: unknown) {
      // 命中判别式却解析失败 → 报**这一家**的具体原因，并停在这里
      return { ok: false, format: adapter.id, label: adapter.label, reason: e instanceof Error ? e.message : '解析失败' }
    }
    if (res && res.ok === false) {
      return { ok: false, format: adapter.id, label: adapter.label, reason: res.reason || '解析失败' }
    }
    const uris = Array.isArray(res?.uris) ? res.uris.filter((uri): uri is string => typeof uri === 'string') : []
    if (!uris.length) { matchedWithoutOutput = adapter; continue }
    return {
      ok: true,
      format: adapter.id,
      label: adapter.label,
      uris,
      warnings: Array.isArray(res?.warnings) ? res.warnings.filter((warning): warning is string => typeof warning === 'string') : []
    }
  }

  if (matchedWithoutOutput) {
    return {
      ok: false,
      format: matchedWithoutOutput.id,
      label: matchedWithoutOutput.label,
      reason: `认出了「${matchedWithoutOutput.label}」，但里面没有可导入的条目`
    }
  }
  return {
    ok: false,
    reason: '认不出这段内容的格式。可以直接粘贴 otpauth:// 链接，或各家 App 的导出（Aegis / 2FAS / andOTP / Bitwarden 的 JSON、Google Authenticator 的迁移链接、1Password 的 1PUX 解压后的 export.data）'
  }
}

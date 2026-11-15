/**
 * 文本 → 「这是什么」—— 扫到之后**先认出内容类型，再决定能做什么**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一层（而不是只把字符串甩给界面）
 * ══════════════════════════════════════════════════════════════════════
 * 二维码本身只是一个字符串容器。"扫到之后能做什么"完全取决于**里面装的是什么**：
 *   · 网址  → 打开它才是用户的意图（让他复制再去粘贴就白扫了）
 *   · otpauth → 这是验证器密钥，能直接入库
 *   · Wi-Fi → 能连、能看密码
 *   · 纯文本 → 只剩复制
 * 分类放在这里（而不是散在界面里一堆 `startsWith`），是因为它是**纯函数**——
 * 可单测、可复用（TOTP 导入链、将来的动作注册表都吃它），且界面只做渲染。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一条纪律：**分类只做"识别"，绝不"猜测并改写"**
 * ══════════════════════════════════════════════════════════════════════
 * 唯一一处"补全"是裸域名（`example.com`）补 `https://` —— 因为不补它就不是链接，
 * 而二维码里裸域名极其常见。补出来的值放在 `href` 里，**原始文本永远原样保留**，
 * 保证"复制"拿到的始终是扫码那一刻的真值，不会被我们改过。
 */

// 「算不算普通网页」的唯一判据（分类只认 http(s)，这里是判据的唯一来源）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'

/** 内容类型（界面按它决定图标、标签与动作）。 */
export const QR_CONTENT = Object.freeze({
  URL: 'url',
  MAIL: 'mail',
  TEL: 'tel',
  OTPAUTH: 'otpauth',
  WIFI: 'wifi',
  GEO: 'geo',
  TEXT: 'text',
  OTHER: 'other'
})

/** 类型 → 中文标签（界面上的小徽标）。 */
const LABELS: Record<string, string> = Object.freeze({
  [QR_CONTENT.URL]: '网址',
  [QR_CONTENT.MAIL]: '邮件',
  [QR_CONTENT.TEL]: '电话',
  [QR_CONTENT.OTPAUTH]: '验证器密钥',
  [QR_CONTENT.WIFI]: 'Wi-Fi',
  [QR_CONTENT.GEO]: '位置',
  [QR_CONTENT.TEXT]: '文本',
  [QR_CONTENT.OTHER]: '其他'
})

/** 裸域名：`example.com`、`a.b.co/path?q=1`（不含协议、不含空格）。 */
const BARE_HOST_RE = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/

/**
 * 值里是否像"有协议头的 URI"（`scheme:` 后跟内容）。
 * 排除 Windows 盘符那种单字母 + 反斜杠的假阳性（`C:\Users\...`）。
 */
function hasScheme(text: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(text)) return false
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)
}

/** 取一段文本的首行（网址作为标题时只显示第一行，避免撑爆窄侧栏）。 */
function firstLine(text: string): string {
  const i = text.indexOf('\n')
  return i === -1 ? text : text.slice(0, i)
}

/** 收紧显示宽度：过长的 URL 在标题里截断（完整值仍在 `text` / `href` 里）。 */
function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * 解析 `otpauth://`（失败也不抛 —— 分类是"尽力而为"，坏链接照样能复制）。
 * @returns {{ issuer: string, account: string, type: string }|null}
 */
function parseOtpauth(text: string): { issuer: string, account: string, type: string }|null {
  try {
    const u = new URL(text)
    const type = (u.hostname || '').toUpperCase()
    const path = decodeURIComponent((u.pathname || '').replace(/^\//, ''))
    let issuer = u.searchParams.get('issuer') || ''
    let account = path
    // 路径写成 `Issuer:account` 时以路径里的 issuer 为准（Google 迁移码的形态）
    const sep = path.indexOf(':')
    if (sep !== -1) {
      if (!issuer) issuer = path.slice(0, sep)
      account = path.slice(sep + 1)
    }
    return { issuer: issuer.trim(), account: account.trim(), type: type || 'TOTP' }
  } catch (_) {
    return null
  }
}

/** 解析 `WIFI:T:WPA;S:SSID;P:pass;;`（分段用 `;`，值里可含转义的 `\;`）。 */
function parseWifi(text: string): { ssid: string; security: string; hidden: boolean } {
  const out = { ssid: '', security: '', hidden: false }
  const body = text.slice(5)
  for (const seg of body.split(/(?<!\\);|\n/)) {
    const i = seg.indexOf(':')
    if (i <= 0) continue
    const key = seg.slice(0, i).toUpperCase()
    const value = seg.slice(i + 1).replace(/\\;/g, ';').replace(/\\\\/g, '\\')
    if (key === 'S') out.ssid = value
    else if (key === 'T') out.security = value
    else if (key === 'H') out.hidden = value === 'true'
  }
  return out
}

/**
 * 识别一段扫到的文本。
 *
 * @param {string} raw 扫到的原始文本（**不做 trim 之外的任何改写**）
 * @returns {{
 *   kind: string,        // QR_CONTENT.*
 *   label: string,       // 中文类型标签
 *   title: string,       // 列表主行（网址显示主机名、验证器显示 服务名 · 账号…）
 *   detail: string,      // 列表次行（可空）
 *   text: string,        // 原始文本（去首尾空白）
 *   href: string|null,   // 可打开的链接（裸域名会补 https://；其余为 null）
 *   schemeMissing: boolean // href 是我们补全出来的
 * }}
 */
export function classifyQrText(raw: string) : {
  kind: string,        // QR_CONTENT.unknown
  label: string,       // 中文类型标签
  title: string,       // 列表主行（网址显示主机名、验证器显示 服务名 · 账号…）
  detail: string,      // 列表次行（可空）
  text: string,        // 原始文本（去首尾空白）
  href: string|null,   // 可打开的链接（裸域名会补 https://；其余为 null）
  schemeMissing: boolean // href 是我们补全出来的
} {
  const text = String(raw == null ? '' : raw).trim()
  const base = { text, href: null, schemeMissing: false, title: '', detail: '' }
  if (!text) {
    return { ...base, kind: QR_CONTENT.OTHER, label: LABELS[QR_CONTENT.OTHER], title: '（空内容）' }
  }

  const label = (kind: string): string => LABELS[kind] || LABELS[QR_CONTENT.OTHER]

  // ── 验证器密钥 ──（放最前：它也是 `scheme:` 形态，必须先于通用 scheme 判定）
  if (/^otpauth:\/\//i.test(text)) {
    const otp = parseOtpauth(text)
    const head = [otp && otp.issuer, otp && otp.account].filter(Boolean).join(' · ')
    return {
      ...base,
      kind: QR_CONTENT.OTPAUTH,
      label: label(QR_CONTENT.OTPAUTH),
      title: head || '验证器密钥',
      detail: otp ? `${otp.type} · 一次性口令` : '一次性口令'
    }
  }

  // ── 网址 ──
  if (isHttpUrl(text)) {
    let host = ''
    try { host = new URL(text).hostname } catch (_) {}
    return {
      ...base,
      kind: QR_CONTENT.URL,
      label: label(QR_CONTENT.URL),
      title: host || shorten(firstLine(text), 40),
      detail: shorten(firstLine(text), 64),
      href: text
    }
  }

  // ── 裸域名（无协议）── 补 https，但**记下是我们补的**，并把原始文本原样留在 text
  if (BARE_HOST_RE.test(text) && !hasScheme(text) && text.includes('.')) {
    return {
      ...base,
      kind: QR_CONTENT.URL,
      label: label(QR_CONTENT.URL),
      title: text.split(/[/?#]/)[0],
      detail: shorten(text, 64),
      href: `https://${text}`,
      schemeMissing: true
    }
  }

  // ── 其余各类 scheme ──
  if (/^mailto:/i.test(text)) {
    return { ...base, kind: QR_CONTENT.MAIL, label: label(QR_CONTENT.MAIL), title: text.slice(7).split('?')[0], detail: shorten(text, 64), href: text }
  }
  if (/^tel:/i.test(text)) {
    return { ...base, kind: QR_CONTENT.TEL, label: label(QR_CONTENT.TEL), title: text.slice(4), href: text }
  }
  if (/^wifi:/i.test(text)) {
    const w = parseWifi(text)
    return {
      ...base,
      kind: QR_CONTENT.WIFI,
      label: label(QR_CONTENT.WIFI),
      title: w.ssid || 'Wi-Fi 网络',
      detail: [w.security, w.hidden ? '隐藏网络' : ''].filter(Boolean).join(' · ')
    }
  }
  if (/^geo:/i.test(text)) {
    return { ...base, kind: QR_CONTENT.GEO, label: label(QR_CONTENT.GEO), title: text.slice(4).split('?')[0], detail: '地理位置' }
  }
  // 其它带协议的（smsto: / bitcoin: / custom: …）——**保留**，不假装认识
  if (hasScheme(text)) {
    const scheme = text.slice(0, text.indexOf(':')).toLowerCase()
    return { ...base, kind: QR_CONTENT.OTHER, label: label(QR_CONTENT.OTHER), title: shorten(firstLine(text), 48), detail: `${scheme}: 链接` }
  }

  // ── 纯文本 ──
  return {
    ...base,
    kind: QR_CONTENT.TEXT,
    label: label(QR_CONTENT.TEXT),
    title: shorten(firstLine(text), 48),
    detail: text.includes('\n') ? `多行文本 · ${text.split('\n').length} 行` : shorten(text, 64)
  }
}

/** 该内容是否可打开（供界面决定给不给「打开」按钮，避免出现点了没反应的按钮）。 */
export function isOpenable(classified: { href?: string | null } | null | undefined): boolean {
  return !!(classified && classified.href)
}


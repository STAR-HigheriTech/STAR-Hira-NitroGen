/**
 * 通用 `otpauth://` 抽取器 —— 两个入口，同一件事。
 *
 * 为什么这一支要**放在适配器链的最后**且永不失败：
 * 它是兜底。任何来源（网页上复制的、别的 App 单条复制的、我们自己的导出）
 * 只要给出的是标准链接，这里就能吃下 —— 于是"兼容某个没专门支持的家"
 * 不再是死路，用户仍有一条路走通。
 *
 * 两个入口的差别只是**输入是文本还是已解析的 JSON**：
 *   · Bitwarden 的 `login.totp`、1Password 的 OTP 字段都是**已经拼好的 URI**，
 *     直接透传比"拆开再用我们的规则重拼"忠实得多（重拼会在编码细节上引入偏差）。
 *   · 1Password 的 1PUX 结构按版本变过，所以对它做**深度遍历找链接**，
 *     而不是硬编某个字段路径 —— 硬编的结果是"下个版本就认不出来"。
 */

/**
 * 从任意文本里抽出所有 `otpauth://` 链接（一行一个、或夹在别的文字里都行）。
 *
 * 尾部的标点要剪掉：用户从聊天/文档里复制时，链接后面常跟着 `，`、`。`、`)`
 * —— 带着它们去解析会被判成"非法链接"，而用户看不出差在哪里。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractOtpauthUris(text: string) : string[] {
  const s = String(text == null ? '' : text)
  const out: string[] = []
  // 链接里可能带空格吗？不会 —— base64/base32 的 secret 与参数都不含空白，
  // 所以"到空白为止"就是正确的边界。
  const re = /otpauth:\/\/[^\s"'<>]+/gi
  let m
  while ((m = re.exec(s)) !== null) {
    const cleaned = m[0].replace(/[),，。；;、】\]}）》」"']+$/, '')
    if (cleaned) out.push(cleaned)
  }
  return out
}

/**
 * 深度遍历任意 JSON 结构，收集所有以 `otpauth://` 开头的字符串值。
 * @param {any} value
 * @param {{ max?: number }} [opts] 防御性上限：坏数据可能是超深/超宽的树
 * @returns {string[]}
 */
export function collectOtpauthUris(value: unknown, opts: { max?: number } = {}): string[] {
  const max = Number.isFinite(opts.max) ? opts.max ?? 5000 : 5000
  const out: string[] = []
  const seen = new Set<unknown>()
  const walk = (v: unknown): void => {
    if (out.length >= max) return
    if (typeof v === 'string') {
      const s = v.trim()
      if (/^otpauth:\/\//i.test(s) && !seen.has(s)) { seen.add(s); out.push(s) }
      return
    }
    if (!v || typeof v !== 'object') return
    if (seen.has(v)) return          // 环（JSON 不该有，但 input 是"外部数据"）
    seen.add(v)
    if (Array.isArray(v)) { for (const item of v) walk(item); return }
    const record = v as Record<string, unknown>
    for (const key of Object.keys(record)) walk(record[key])
  }
  walk(value)
  return out
}

/** 通用兜底适配器：整段文本里能找出几条链接就吃几条。 */
export const otpauthTextAdapter = {
  id: 'otpauth-uri',
  label: 'otpauth 链接',
  match(text: string): boolean {
    return extractOtpauthUris(text).length > 0
  },
  decode(text: string) {
    return { uris: extractOtpauthUris(text), warnings: [] }
  }
}

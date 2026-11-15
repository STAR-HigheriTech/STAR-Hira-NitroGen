/**
 * form-fill —— 「支付卡 / 地址自动填充」（N7）的**唯一纯规则**。
 *
 * 两类条目：
 *   · `address` —— 收货地址（姓名 / 单位 / 街道 / 城市 / 省 / 邮编 / 国家 / 电话 / 邮箱）
 *   · `card`    —— 支付卡（持卡人 / 卡号 / 有效期）
 *
 * 形状、归一、掩码都在这一处：管理页（渲染层）、保管库（主进程）、
 * 以及将来的页面填充脚本三边共用 —— 各写一份必然在"哪个字段叫什么"上漂移。
 *
 * ⚠ 本模块**只处理结构，不处理加密**：明文绝不出现在这里，也没有任何落盘逻辑。
 *   密文由主进程的 safeStorage provider 负责（与密码同一条纪律）。
 */

/** 地址字段（键 → 中文名）。顺序即表单上的常见顺序。 */
export const ADDRESS_FIELDS = Object.freeze([
  ['name', '姓名'],
  ['organization', '单位'],
  ['street', '街道地址'],
  ['city', '城市'],
  ['region', '省 / 州'],
  ['postalCode', '邮政编码'],
  ['country', '国家 / 地区'],
  ['phone', '电话'],
  ['email', '邮箱']
])

/** 支付卡字段（键 → 中文名）。 */
export const CARD_FIELDS = Object.freeze([
  ['holder', '持卡人'],
  ['number', '卡号'],
  ['expMonth', '有效期（月）'],
  ['expYear', '有效期（年）']
])

/** 条目类型枚举。 */
export const FORM_FILL_KINDS = Object.freeze(['address', 'card'])

/**
 * 网页 `autocomplete` 属性 → 我们的字段键。
 *
 * 这是"该填哪一格"的**首选判据**：标准的 `autocomplete` 是站点自己声明的语义，
 * 比启发式猜测可靠得多，判据本身也几乎零成本（读一个属性）。
 * 组合式 `cc-exp`（月/年合一）刻意不映射 —— 它的分隔方式随站点而异，
 * 猜错会把"12/26"填成一个月的年份；宁可只处理分开的 month / year。
 */
export const AUTOCOMPLETE_KEY_MAP = Object.freeze({
  'given-name': 'name',
  'additional-name': 'name',
  name: 'name',
  'cc-name': 'holder',
  organization: 'organization',
  'street-address': 'street',
  'address-line1': 'street',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  email: 'email',
  'cc-number': 'number',
  'cc-exp-month': 'expMonth',
  'cc-exp-year': 'expYear'
})

/**
 * 该 `autocomplete` 值属于哪一类条目（`'address' | 'card' | null`）。
 * @param {unknown} autocomplete
 * @returns {'address'|'card'|null}
 */
export function formFillKindOfAutocomplete(autocomplete: unknown) : 'address'|'card'|null {
  const key = String(autocomplete == null ? '' : autocomplete).trim().toLowerCase()
  const mapped = AUTOCOMPLETE_KEY_MAP[key as keyof typeof AUTOCOMPLETE_KEY_MAP]
  if (!mapped) return null
  return CARD_FIELDS.some(([k]) => k === mapped) ? 'card' : 'address'
}

/** 一个条目最多保存多少个字段（防御手改后的畸形数据）。 */
const MAX_FIELDS = 16

/**
 * 只保留数字（卡号用）。
 * @param {unknown} v
 * @returns {string}
 */
export function digitsOnly(v: unknown) : string {
  return String(v == null ? '' : v).replace(/\D+/g, '')
}

/**
 * 卡号掩码：只露后四位（`•••• 1234`）。
 * 展示层**永远**用掩码，只有显式"显示/复制"才取明文。
 * @param {unknown} number
 * @returns {string}
 */
export function maskCardNumber(number: unknown) : string {
  const d = digitsOnly(number)
  if (!d) return ''
  const tail = d.slice(-4)
  return `${'•'.repeat(Math.max(0, d.length - 4))} ${tail}`.trim()
}

/**
 * 某个条目在列表里的**摘要**（不含任何敏感明文）。
 * @param {{ kind?: string, label?: string, data?: object }} entry
 * @returns {{ label: string, detail: string }}
 */
export function entrySummary(entry: { kind?: string, label?: string, data?: object }) : { label: string, detail: string } {
  const kind = entry && entry.kind === 'card' ? 'card' : 'address'
  const label = String((entry && entry.label) || '').trim()
  const data = (entry && entry.data ? entry.data : {}) as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name : ''
  if (kind === 'card') {
    const tail = maskCardNumber(data.number)
    const exp = [data.expMonth, data.expYear]
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .join('/')
    const holder = typeof data.holder === 'string' ? data.holder : ''
    return {
      label: label || tail || '支付卡',
      detail: [tail, exp, holder].filter(Boolean).join(' · ')
    }
  }
  const lines = [data.name, data.street, data.city, data.postalCode]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return {
    label: label || name || '地址',
    detail: lines.join(' · ')
  }
}

/**
 * 归一化一个条目：类型非法 → null；字段只保留白名单里的非空项。
 * @param {any} input
 * @returns {{ kind:'address'|'card', label:string, data:Record<string,string> }|null}
 */
export function normalizeFormFillEntry(input: unknown) : { kind:'address'|'card', label:string, data:Record<string,string> }|null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const kind = source.kind === 'card' ? 'card' : (source.kind === 'address' ? 'address' : null)
  if (!kind) return null
  const allowed = new Set((kind === 'card' ? CARD_FIELDS : ADDRESS_FIELDS).map(([k]) => k))
  const src = source.data && typeof source.data === 'object' ? source.data as Record<string, unknown> : {}
  const data: Record<string, string> = {}
  for (const key of Object.keys(src).slice(0, MAX_FIELDS)) {
    if (!allowed.has(key)) continue
    const value = String(src[key] == null ? '' : src[key]).trim()
    if (value) data[key] = value
  }
  // 一个字段都没有的条目没有意义（也填不进去）。
  if (Object.keys(data).length === 0) return null
  // 卡号统一成纯数字：用户习惯分段输入，存分段值会让"后四位"判定失真。
  if (kind === 'card' && data.number) data.number = digitsOnly(data.number)
  if (kind === 'card' && !data.number) return null
  return { kind, label: String(source.label == null ? '' : source.label).trim(), data }
}

/**
 * 解析保管库里的 JSON 串 → 条目数组（任何异常退化为空数组，绝不抛）。
 * @param {unknown} raw
 * @returns {Array<{id:string, kind:string, label:string, updatedAt:number, data:object}>}
 */
export function parseFormFillEntries(raw: unknown) : Array<{id:string, kind:string, label:string, updatedAt:number, data:object}> {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch (_) {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const norm = normalizeFormFillEntry(item)
    if (!norm) continue
    out.push({
      id: String(item.id || '').trim() || `${norm.kind}-${out.length}`,
      kind: norm.kind,
      label: norm.label,
      updatedAt: Number(item.updatedAt) || 0,
      data: norm.data
    })
  }
  return out
}

/**
 * 条目数组 → 落盘用的 JSON 串（空数组 → 空串，与其它设置项一致）。
 * @param {any[]} list
 * @returns {string}
 */
export function serializeFormFillEntries(list: readonly unknown[] | null | undefined) : string {
  const items = (Array.isArray(list) ? list : [])
    .map((item) => {
      const norm = normalizeFormFillEntry(item)
      if (!norm) return null
      return {
        id: String(item.id || '').trim(),
        kind: norm.kind,
        label: norm.label,
        updatedAt: Number(item.updatedAt) || 0,
        data: norm.data
      }
    })
    .filter(Boolean)
  if (items.length === 0) return ''
  return JSON.stringify(items)
}

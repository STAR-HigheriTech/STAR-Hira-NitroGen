/**
 * JSON 类导入适配器的**共同骨架**。
 *
 * 五个家（Aegis / 2FAS / andOTP / Bitwarden / 1Password）的导出都是 JSON，
 * 差异只有两处：**怎么认出是它**（`match`）与**从哪个字段取条目**（`pick`）。
 * 把这两件事抽成参数，每家就只剩十行 —— 于是"新增一家"真的只是加一个文件。
 *
 * 判别式必须**足够严格**：match 是"第一个匹配的适配器胜出"，
 * 宽松的 match（比如"有 entries 数组就算 Aegis"）会把别的格式抢过去，
 * 而表现是"导入成功但条目全错"，比认不出来更糟。
 */

import { entriesToUris } from './uri.js'

type JsonObject = Record<string, unknown>
type JsonMatch = (json: JsonObject) => boolean
type PickedEntries = { entries?: unknown[]; warnings?: string[]; ok?: true }
type PickedUris = { uris?: string[]; warnings?: string[]; ok?: true }
type PickFailure = { ok: false; reason: string }
type PickResult = PickedEntries | PickedUris | PickFailure

/**
 * @param {{
 *   id: string,
 *   label: string,
 *   match: (json: any) => boolean,
 *   pick: (json: any) => { entries?: any[], warnings?: string[] } | { ok: false, reason: string }
 * }} spec
 */
export function makeJsonAdapter(spec: {
  id: string
  label: string
  match: JsonMatch
  pick: (json: JsonObject) => PickResult
}) {
  return {
    id: spec.id,
    label: spec.label,
    match(_text: string, json: unknown): boolean {
      if (!json || typeof json !== 'object') return false
      try { return spec.match(json as JsonObject) === true } catch (_) { return false }
    },
    decode(_text: string, json: unknown) {
      const picked = spec.pick(json && typeof json === 'object' ? json as JsonObject : {})
      // pick 可以主动**拒绝**（例如"这是加密备份"）—— 那时给出的是可读原因，
      // 而不是"认不出来"。两者对用户的意义完全不同：一个是"要怎么做"，
      // 一个是"这东西是什么"。
      if (picked.ok === false) return { ok: false, reason: picked.reason }
      /**
       * pick 有两种产出，由**数据本身**决定哪种：
       *   · `uris`   —— 这一家存的本来就是拼好的 `otpauth://` 链接（Bitwarden / 1Password）。
       *                 **原样透传**，不拆开重拼：重拼会在编码细节上引入偏差，
       *                 而透传零风险（那串东西本来就是别的 App 认的格式）。
       *   · `entries`—— 这一家存的是裸密钥（Aegis / 2FAS / andOTP），必须由我们拼。
       */
      if ('uris' in picked && Array.isArray(picked.uris)) {
        return { uris: picked.uris, warnings: (picked.warnings || []).slice() }
      }
      return entriesToUris(picked as PickedEntries)
    }
  }
}

/** 安全的数组取值（各家字段名不同、类型也可能不对）。 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 取第一个非空字符串。 */
export function str(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

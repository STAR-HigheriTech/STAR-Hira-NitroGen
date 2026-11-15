/**
 * form-fill —— 「支付卡 / 地址自动填充」（N7）的**加密保管库**（主进程侧）。
 *
 * ── 明文纪律（与密码完全一致）───────────────────────────────────────
 * 落盘的只有 **safeStorage 加密后的密文**；明文只在主进程内、在"加密写入"与
 * "显式揭示"这两个时刻存在，从不随列表返回。列表给渲染层的只有**掩码 / 摘要**
 *（见纯层 `entrySummary`），因此"看一眼列表"不会把卡号暴露到渲染进程。
 *
 * ── 为什么存设置项而不是新建表 ──────────────────────────────────────
 * 条目量级是"几个地址 + 几张卡"，属于**结构化小集合** —— 与归档区
 *（`archive.entries`）、命名会话（`sessions.named`）同族，走设置项即可：
 * 天然随 profile 隔离、不需要建表与迁移，磁盘上只是一段密文 JSON。
 *
 * ── 与「自动填充」的关系 ────────────────────────────────────────────
 * 本模块只负责**保管与读取**；把值写进网页表单是页面侧（preload）的事。
 * 两者用同一份纯规则（shared-types#form-fill）对齐字段名，避免"存的是 postalCode、
 * 填的时候找 zip"这类静默错位。
 *
 * @param {object} deps
 * @param {{ get:Function, set:Function }} deps.settings 设置服务（读写 `privacy.form_fill_entries`）
 * @param {{ encrypt:(plain:string)=>string|null, decrypt:(b64:string)=>string, isAvailable?:Function }} deps.crypto
 *        与密码/验证器同一套 OS 级加密 provider（见 infra-secret）
 */

const {
  normalizeFormFillEntry,
  entrySummary
} = require('@hira-ng/shared-types/src/form-fill.mjs')
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')

/** 存储键（设置项）。 */
const FORM_FILL_KEY = PRIVACY_SETTING_KEYS.formFillEntries

interface FormFillRawEntry { id: string; kind: 'card' | 'address'; label: string; updatedAt: number; cipher: string }
interface FormFillDeps { settings?: { get: (key: string) => unknown; set: (key: string, value: unknown) => unknown } | null; crypto?: { encrypt?: (plain: string) => string | null; decrypt?: (cipher: string) => string; isAvailable?: () => boolean } | null }
interface FormFillInput { kind: 'card' | 'address'; label: string; data: Record<string, unknown> }


function createFormFillVault(deps: FormFillDeps = {}) {
  const settings = deps.settings || null
  const crypto = deps.crypto || null

  const canEncrypt = () =>
    !!(crypto && typeof crypto.encrypt === 'function' &&
      (typeof crypto.isAvailable !== 'function' || crypto.isAvailable()))

  /** 读原始记录数组（`{ id, kind, label, updatedAt, cipher }`）。任何异常 → 空数组。 */
  function readRaw(): FormFillRawEntry[] {
    try {
      const raw = settings && typeof settings.get === 'function' ? settings.get(FORM_FILL_KEY) : ''
      if (!raw) return []
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw
      return Array.isArray(list) ? list.filter((item): item is FormFillRawEntry => !!item && typeof item === 'object' && typeof (item as FormFillRawEntry).cipher === 'string') : []
    } catch (_) {
      return []
    }
  }

  function writeRaw(list: FormFillRawEntry[]): boolean {
    const value = Array.isArray(list) && list.length ? JSON.stringify(list) : ''
    try {
      if (settings && typeof settings.set === 'function') {
        settings.set(FORM_FILL_KEY, value)
        return true
      }
    } catch (error) {
      console.warn('[form-fill] 保存失败:', error instanceof Error ? error.message : error)
    }
    return false
  }

  /** 解密一条记录的 payload（data 对象）；失败返回 null。 */
  function decryptData(record: FormFillRawEntry): Record<string, unknown> | null {
    try {
      const plain = crypto && typeof crypto.decrypt === 'function' ? crypto.decrypt(record.cipher) : ''
      if (!plain) return null
      const parsed = JSON.parse(plain)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      console.warn('[form-fill] 解密失败（条目可能来自另一台机器）:', error instanceof Error ? error.message : error)
      return null
    }
  }

  return {
    isAvailable: canEncrypt,

    /**
     * 列出全部条目 —— **只回摘要**（掩码 / 前几段），绝不回明文。
     * @returns {Promise<{ items: Array<{id:string,kind:string,label:string,updatedAt:number,detail:string}> }>}
     */
    async list() : Promise<{ items: Array<{id:string,kind:string,label:string,updatedAt:number,detail:string}> }> {
      const items: Array<{ id: string; kind: string; label: string; updatedAt: number; detail: string }> = []
      for (const record of readRaw()) {
        const data = decryptData(record)
        if (!data) continue
        const summary = entrySummary({ kind: record.kind, label: record.label, data })
        items.push({
          id: String(record.id || ''),
          kind: record.kind === 'card' ? 'card' : 'address',
          label: summary.label,
          updatedAt: Number(record.updatedAt) || 0,
          detail: summary.detail
        })
      }
      return { items }
    },

    /**
     * **填充用**的选项：按类型回可填的条目（带明文 data）。
     *
     * ⚠ 与 `list()` 的差别是刻意的：`list()` 只回摘要（掩码），供管理页展示；
     *   本条会带明文，因为**页面填充必须拿到值**（Chrome 等也是把值交给渲染层去填）。
     *   两条防线把暴露面压到最小：
     *     ① 按类型收窄 —— 聚焦"卡号"时不会把地址条目一起递出去；
     *     ② 主进程还会先看 `privacy.form_autofill` 开关（见 ipc/form-fill.js）。
     * @param {string} kind 'address' | 'card'
     * @returns {Promise<{ items: Array<{id:string,label:string,detail:string,data:object}> }>}
     */
    async options(kind: string): Promise<{ items: Array<{ id: string; kind: string; label: string; detail: string; data: Record<string, unknown> }> }> {
      const want = kind === 'card' ? 'card' : 'address'
      const items: Array<{ id: string; kind: string; label: string; detail: string; data: Record<string, unknown> }> = []
      for (const record of readRaw()) {
        if ((record.kind === 'card' ? 'card' : 'address') !== want) continue
        const data = decryptData(record)
        if (!data) continue
        const summary = entrySummary({ kind: record.kind, label: record.label, data })
        items.push({ id: String(record.id || ''), kind: want, label: summary.label, detail: summary.detail, data })
      }
      return { items }
    },

    /**
     * 新增一条（加密后落盘）。
     * @param {object} input `{ kind, label, data }`
     * @returns {Promise<{ ok: boolean, id?: string, reason?: string }>}
     */
    async add(input: FormFillInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
      if (!canEncrypt()) return { ok: false, reason: '系统加密不可用，无法安全保存' }
      const norm = normalizeFormFillEntry(input)
      if (!norm) return { ok: false, reason: '请至少填写一项内容' }
      let cipher = null
      try {
        cipher = crypto!.encrypt!(JSON.stringify(norm.data))
      } catch (error) {
        console.warn('[form-fill] 加密失败:', error instanceof Error ? error.message : error)
      }
      if (!cipher) return { ok: false, reason: '加密失败，未保存' }
      const id = `ff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const next = readRaw().concat({ id, kind: norm.kind, label: norm.label, updatedAt: Date.now(), cipher })
      if (!writeRaw(next)) return { ok: false, reason: '写入设置失败' }
      return { ok: true, id }
    },

    /**
     * 删除一条。
     * @param {string} id
     * @returns {Promise<{ ok: boolean }>}
     */
    async remove(id: string): Promise<{ ok: boolean }> {
      const key = String(id == null ? '' : id)
      const next = readRaw().filter((r) => String(r.id || '') !== key)
      return { ok: writeRaw(next) }
    },

    /**
     * **显式揭示**一条的明文（管理页点"显示 / 复制"时才调）。
     * 这是明文唯一的出口，且只回一条 —— 列表接口永远不给明文。
     * @param {string} id
     * @returns {Promise<{ ok: boolean, kind?: string, data?: object, reason?: string }>}
     */
    async reveal(id: string): Promise<{ ok: boolean; kind?: string; data?: Record<string, unknown>; reason?: string }> {
      const key = String(id == null ? '' : id)
      const record = readRaw().find((r) => String(r.id || '') === key)
      if (!record) return { ok: false, reason: '条目不存在' }
      const data = decryptData(record)
      if (!data) return { ok: false, reason: '无法解密该条目' }
      return { ok: true, kind: record.kind === 'card' ? 'card' : 'address', data }
    }
  }
}

module.exports = { createFormFillVault, FORM_FILL_KEY }

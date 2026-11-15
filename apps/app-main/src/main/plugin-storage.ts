// @ts-check
/**
 * 插件键值存储 —— 插件开放 API 的**持久化面**（唯一实现处）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 插件要在"两次打开面板之间记住点什么"，此前没有任何合法落点：
 *   · `localStorage` —— HTML/XAML 面板跑在**无同源**的沙箱 iframe 里（opaque origin），
 *     每次加载都可能是一个新的存储分区，等于没有持久化；
 *   · `kv` —— 全局库，不按 profile 分区，插件数据会跨档案串味；
 *   · `settings` —— 有 schema 校验，插件拿不到任意键。
 *
 * ── 隔离与配额（这三条是数据保护的全部） ────────────────────────────
 *   · **按 profile 分区**：`profile_id` 并入主键。切档案 = 换一份插件数据，
 *     与业务表的行为一致（用户不会在另一个档案里看到别的档案的插件草稿）。
 *   · **按插件隔离**：`plugin_id` 并入主键。读写一律带它 —— 一个插件永远看不见另一个的键。
 *   · **配额**：每插件 ≤ 512 键、单值 ≤ 256 KiB、总量 ≤ 4 MiB。
 *     超限**拒绝写入**而不是静默截断：插件作者需要看到确切原因。
 *
 * ── 为什么不做"按调用方鉴权" ────────────────────────────────────────
 * 沙箱 iframe 没有可信身份，主进程无法区分是谁在调。真正的闸门在**父侧桥**
 * （`renderer/shared/panel-ui-bridge.js`）：它用自己的 `pluginId` 覆写请求参数，
 * 并按 `storage:read` / `storage:write` 两个 scope 判定放行。本层只负责形状、
 * 隔离与配额 —— 规则只写一处，不在两个地方各判一半。
 */

import { PLUGIN_STORAGE_DDL, type SqliteHandle } from '@hira-ng/infra-db'
import { normalizePluginId } from '@hira-ng/shared-types/src/plugin-id'

interface PluginStorageGetResult { ok: boolean; value: string | null; updatedAt: number | null; reason?: string }
interface PluginStorageSetResult { ok: boolean; keys?: number; bytes?: number; reason?: string }
interface PluginStorageRemoveResult { ok: boolean; removed: number }
interface PluginStorageKeysResult { ok: boolean; keys: Array<{ key: string; updatedAt: number }> }
interface PluginStorageUsage { keys: number; bytes: number }

export interface PluginStorage {
  readonly limits: Readonly<{ maxKeys: number; maxValueBytes: number; maxTotalBytes: number }>
  get(pluginId: unknown, key: unknown): PluginStorageGetResult
  set(pluginId: unknown, key: unknown, value: unknown): PluginStorageSetResult
  remove(pluginId: unknown, key: unknown): PluginStorageRemoveResult
  keys(pluginId: unknown, prefix?: unknown): PluginStorageKeysResult
  clear(pluginId: unknown): PluginStorageRemoveResult
  usage(pluginId: unknown): PluginStorageUsage
}

export interface PluginStorageOptions {
  sqlite: SqliteHandle
  getProfileId(): string
  log?: Pick<Console, 'warn'>
}

export const PLUGIN_STORAGE_LIMITS = Object.freeze({
  maxKeys: 512,
  maxValueBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxKeyLength: 256
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每插件最多多少个键。 */
const MAX_KEYS = 512
/** 单个 value 的最大字节数（UTF-8）。 */
const MAX_VALUE_BYTES = 256 * 1024
/** 每插件全部 value 的总字节上限。 */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
/** 键名最大长度（字符）。 */
const MAX_KEY_LENGTH = 256
/** 控制字符不可进键名：它们在日志/界面里不可见，出错时完全无法自查。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

/**
 * @param {string} value
 * @returns {number} UTF-8 字节数
 */
function byteLength(value: unknown): number {
  return Buffer.byteLength(String(value), 'utf8')
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeKey(raw: unknown): string | null {
  const key = String(raw == null ? '' : raw)
  if (!key || key.length > MAX_KEY_LENGTH) return null
  if (CONTROL_CHARS_RE.test(key)) return null
  return key
}

/**
 * 创建插件存储。
 *
 * @param {{
 *   sqlite: { prepare: Function, exec: Function },
 *   getProfileId: () => string,
 *   log?: Pick<Console, 'warn'>
 * }} options
 *   `sqlite` 是**按当前 profile 路由**的代理（见 infra-db#createDbProvider）：
 *   每次 `.prepare()` 都落到当前档案的库，因此这里不需要认识 profile 路由规则。
 */
export function createPluginStorage({ sqlite, getProfileId, log = console }: PluginStorageOptions): PluginStorage {
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new Error('[plugin-storage] 需要 sqlite 句柄')
  }

  /** 已确认建过表的 profile（`CREATE TABLE IF NOT EXISTS` 每个库各跑一次）。 */
  const ensuredProfiles = new Set<string>()

  function currentProfileId(): string {
    try {
      const v = typeof getProfileId === 'function' ? getProfileId() : ''
      return v ? String(v) : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /**
   * 幂等建表（自愈）。
   *
   * 正常路径上表由 `ensureSchema` 建好；但"代码升级前就已经打开的库"在同一进程内
   * 不会重跑 DDL —— 少了这一步，插件存储会以 `no such table` 失败，而用户看到的
   * 只是一句"保存失败"。DDL 与 infra-db 共用同一份常量，不在这里抄第二份。
   */
  function ensure(profileId: string): void {
    if (ensuredProfiles.has(profileId)) return
    try {
      sqlite.exec(PLUGIN_STORAGE_DDL)
      ensuredProfiles.add(profileId)
    } catch (e) {
      log.warn('[plugin-storage] 建表失败:', errorMessage(e))
    }
  }

  /** `{ keys, bytes }` —— 当前 profile 下某插件的用量。 */
  function usageOf(profileId: string, pluginId: string): PluginStorageUsage {
    const row = sqlite.prepare(
      `SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes
         FROM plugin_storage WHERE profile_id = ? AND plugin_id = ?`
    ).get(profileId, pluginId) as Record<string, unknown> | undefined
    return { keys: Number((row && row.keys) || 0), bytes: Number((row && row.bytes) || 0) }
  }

  /** 读到 `{ value }` 时只取单键，避免为了一个键把统计也算一遍。 */
  function sizeOf(profileId: string, pluginId: string, key: string): number {
    const row = sqlite.prepare(
      `SELECT LENGTH(CAST(value AS BLOB)) AS bytes
         FROM plugin_storage WHERE profile_id = ? AND plugin_id = ? AND key = ?`
    ).get(profileId, pluginId, key) as Record<string, unknown> | undefined
    return row ? Number(row.bytes || 0) : -1
  }

  return {
    /** 配额常量（渲染层/插件中心展示"还剩多少"时读它，不要在别处再抄一份数字）。 */
    limits: Object.freeze({ maxKeys: MAX_KEYS, maxValueBytes: MAX_VALUE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }),

    /** @returns {{ ok: boolean, value: string|null, updatedAt: number|null }} */
    get(pluginId: unknown, key: unknown): PluginStorageGetResult {
      const id = normalizePluginId(pluginId)
      const k = normalizeKey(key)
      if (!id || !k) return { ok: false, value: null, updatedAt: null }
      const profileId = currentProfileId()
      ensure(profileId)
      try {
        const row = sqlite.prepare(
          `SELECT value, updated_at FROM plugin_storage
            WHERE profile_id = ? AND plugin_id = ? AND key = ?`
        ).get(profileId, id, k) as Record<string, unknown> | undefined
        return row
          ? { ok: true, value: String(row.value), updatedAt: Number(row.updated_at) }
          : { ok: true, value: null, updatedAt: null }
      } catch (e) {
        return { ok: false, value: null, updatedAt: null, reason: errorMessage(e) }
      }
    },

    /** @returns {{ ok: boolean, keys?: number, bytes?: number, reason?: string }} */
    set(pluginId: unknown, key: unknown, value: unknown): PluginStorageSetResult {
      const id = normalizePluginId(pluginId)
      const k = normalizeKey(key)
      if (!id) return { ok: false, reason: `插件 id 不合法：${String(pluginId).slice(0, 64)}` }
      if (!k) return { ok: false, reason: `存储键不合法（1–${MAX_KEY_LENGTH} 字符，且不含控制字符）` }
      const text = String(value == null ? '' : value)
      const incoming = byteLength(text)
      if (incoming > MAX_VALUE_BYTES) {
        return { ok: false, reason: `单个值超过上限（${Math.round(incoming / 1024)} KiB > ${MAX_VALUE_BYTES / 1024} KiB）` }
      }
      const profileId = currentProfileId()
      ensure(profileId)
      try {
        const previous = sizeOf(profileId, id, k)
        const usage = usageOf(profileId, id)
        if (previous < 0 && usage.keys >= MAX_KEYS) {
          return { ok: false, reason: `存储键数量已达上限（${MAX_KEYS}）` }
        }
        const nextBytes = usage.bytes - Math.max(previous, 0) + incoming
        if (nextBytes > MAX_TOTAL_BYTES) {
          return {
            ok: false,
            reason: `存储总量超过上限（${Math.round(nextBytes / 1024)} KiB > ${MAX_TOTAL_BYTES / 1024} KiB）`
          }
        }
        sqlite.prepare(
          `INSERT INTO plugin_storage (profile_id, plugin_id, key, value, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, plugin_id, key)
           DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(profileId, id, k, text, Date.now())
        const after = usageOf(profileId, id)
        return { ok: true, keys: after.keys, bytes: after.bytes }
      } catch (e) {
        return { ok: false, reason: errorMessage(e) }
      }
    },

    /** @returns {{ ok: boolean, removed: number }} */
    remove(pluginId: unknown, key: unknown): PluginStorageRemoveResult {
      const id = normalizePluginId(pluginId)
      const k = normalizeKey(key)
      if (!id || !k) return { ok: false, removed: 0 }
      const profileId = currentProfileId()
      ensure(profileId)
      try {
        const info = sqlite.prepare(
          `DELETE FROM plugin_storage WHERE profile_id = ? AND plugin_id = ? AND key = ?`
        ).run(profileId, id, k)
        return { ok: true, removed: Number(info.changes || 0) }
      } catch (e) {
        log.warn('[plugin-storage] 删除失败:', errorMessage(e))
        return { ok: false, removed: 0 }
      }
    },

    /** @returns {{ ok: boolean, keys: Array<{ key: string, updatedAt: number }> }} */
    keys(pluginId: unknown, prefix?: unknown): PluginStorageKeysResult {
      const id = normalizePluginId(pluginId)
      if (!id) return { ok: false, keys: [] }
      const profileId = currentProfileId()
      ensure(profileId)
      const head = typeof prefix === 'string' ? prefix : ''
      try {
        const rows: Array<Record<string, unknown>> = head
          ? sqlite.prepare(
            `SELECT key, updated_at FROM plugin_storage
              WHERE profile_id = ? AND plugin_id = ? AND key LIKE ? ESCAPE '\\'
              ORDER BY key`
          ).all(profileId, id, `${head.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) as Array<Record<string, unknown>>
          : sqlite.prepare(
            `SELECT key, updated_at FROM plugin_storage
              WHERE profile_id = ? AND plugin_id = ? ORDER BY key`
          ).all(profileId, id) as Array<Record<string, unknown>>
        return {
          ok: true,
          keys: rows.map((row) => ({ key: String(row.key), updatedAt: Number(row.updated_at) }))
        }
      } catch (e) {
        log.warn('[plugin-storage] 列键失败:', errorMessage(e))
        return { ok: false, keys: [] }
      }
    },

    /** @returns {{ ok: boolean, removed: number }} */
    clear(pluginId: unknown): PluginStorageRemoveResult {
      const id = normalizePluginId(pluginId)
      if (!id) return { ok: false, removed: 0 }
      const profileId = currentProfileId()
      ensure(profileId)
      try {
        const info = sqlite.prepare(
          `DELETE FROM plugin_storage WHERE profile_id = ? AND plugin_id = ?`
        ).run(profileId, id)
        return { ok: true, removed: Number(info.changes || 0) }
      } catch (e) {
        log.warn('[plugin-storage] 清空失败:', errorMessage(e))
        return { ok: false, removed: 0 }
      }
    },

    /** 用量（不读值）—— 插件中心/调试页判断"还剩多少"用。 */
    usage(pluginId: unknown): PluginStorageUsage {
      const id = normalizePluginId(pluginId)
      if (!id) return { keys: 0, bytes: 0 }
      const profileId = currentProfileId()
      ensure(profileId)
      try {
        return usageOf(profileId, id)
      } catch (_) {
        return { keys: 0, bytes: 0 }
      }
    }
  }
}


/**
 * 空间归档（空间级导出 / 导入）—— **格式真源**。
 *
 * ── 与 profile-archive 的关系 ──────────────────────────────────────
 * 两者刻意同构：都是「自描述单文件 JSON（零压缩依赖）+ 版本化 + 先校验再动手」。
 * 差别只在**粒度**：
 *   · profile 归档 = 整份用户档案（表 + 根级/各空间的 JSON）；
 *   · 空间归档   = 一个工作空间（元数据 + 该空间自己的 settings/session JSON）。
 * 因此文件名、扩展名、`format` 标识各一套，互不混淆；导入也永远**只新建**空间。
 *
 * ── 这个文件里为什么有 id/name 规则的一份副本 ──────────────────────
 * shared-types 是最底层，**不能**反向 require domain-space；而"导入时给一个
 * 不冲突的空间 id"是格式层职责（和 `fitProfileName` 在 shared-types 里同理）。
 * 副本只保留"归一 + 长度 + 冲突让步"三件最小事，真正的业务规则仍在
 * domain-space#spaceUtil，两边口径由本文件的注释对齐。
 */

/** 归档标识（`format` 字段）—— 用来一眼区分"本应用的空间包"与任意 JSON。 */
export const SPACE_ARCHIVE_FORMAT = 'hira-space-archive'

/** 归档版本。**只增不改**：老包必须永远能被新版本读进来。 */
export const SPACE_ARCHIVE_VERSION = 1

/** 归档文件扩展名（保存对话框用）。 */
export const SPACE_ARCHIVE_EXTENSION = 'hiraspace'

/**
 * 单包上限（字节）。空间只带元数据与两份小 JSON，正常远低于此值；
 * 超限**报错**而不是静默截断 —— 截断等于悄悄丢用户数据。
 */
export const SPACE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024

/**
 * 允许进包的**空间目录内**文件名（白名单，导入时同样按它过滤）。
 *   · settings.json      —— 空间级设置（目前是 app.theme 等少数键）
 *   · session.json       —— 主窗口的会话
 *   · session-w<n>.json  —— 其他窗口的会话分片（多窗口）
 * 空间目录里只有这几类文件是我们写的；白名单让"到底带走了什么"一眼可见。
 */
export const SPACE_ARCHIVE_FILE_PATTERN = /^(settings|session)(-w\d+)?\.json$/

/** 与 domain-space#spaceUtil 同口径：id 只允许字母数字、`-`、`_`，最长 64。 */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const ID_MAX_LEN = 64
/** 与 domain-space#spaceUtil 同口径的空间名称上限。 */
const NAME_MAX_LEN = 40

/**
 * 归一 space id：trim → 小写 → 只允许 `[a-zA-Z0-9_-]` → 长度 ≤64。
 * 非法返回 ''（导入时再走 `allocateSpaceId` 的兜底）。
 * @param {*} input
 * @returns {string}
 */
export function normalizeSpaceId(input: unknown) : string {
  if (typeof input !== 'string') return ''
  const s = input.trim().toLowerCase()
  if (s.length === 0 || s.length > ID_MAX_LEN) return ''
  if (!ID_PATTERN.test(s)) return ''
  return s
}

/**
 * 建议的归档文件名（保存对话框默认名）—— 用空间名，抹掉文件系统非法字符。
 * @param {string} [name]
 * @returns {string}
 */
export function spaceArchiveFileNameFor(name: string) : string {
  const base = String(name || 'space')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return `${base || 'space'}.${SPACE_ARCHIVE_EXTENSION}`
}

/**
 * 把名字收进空间名称长度上限，并叠一个后缀（如「 (导入)」）。
 * 超长时截断主体而不是后缀 —— 后缀是这次导入的语义标记，不能丢。
 * @param {string} base
 * @param {string} [suffix]
 * @returns {string}
 */
export function fitSpaceName(base: string, suffix: string = '') : string {
  const clean = String(base || '').trim()
  const room = Math.max(1, NAME_MAX_LEN - suffix.length)
  const head = clean.length > room ? clean.slice(0, room) : clean
  return `${head}${suffix}`.trim()
}

/**
 * 为导入分配一个**目标 profile 内唯一**的空间 id。
 *
 * 规则：优先沿用包里的 id（这样"导出再导回"能保持可读的 id），
 * 冲突时退让为 `-2`、`-3`…；兜底用时间戳后缀，保证一定能落地。
 * @param {string} rawId 包里的 id（可能为空/非法/超长）
 * @param {Iterable<string>} existingIds 目标 profile 现有空间 id
 * @returns {string} 合法且未占用的 id
 */
export function allocateSpaceId(rawId: string, existingIds: Iterable<string>) : string {
  const taken = new Set(
    Array.from(existingIds || [], (id) => String(id || '').toLowerCase()).filter(Boolean)
  )
  const base = normalizeSpaceId(rawId) || 'space'
  if (!taken.has(base)) return base

  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`
    const head = base.slice(0, Math.max(1, ID_MAX_LEN - suffix.length))
    const candidate = `${head}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  // 极端情况（999 个同名前缀）：时间戳后缀，长度仍受 ID_MAX_LEN 约束。
  const suffix = `-${Date.now().toString(36)}`
  const head = base.slice(0, Math.max(1, ID_MAX_LEN - suffix.length))
  return `${head}${suffix}`
}

/**
 * 校验一份空间归档载荷（**在动任何数据之前**调用）。
 * 只做"能不能读懂、要不要拒绝"，不做任何修补。
 * @param {unknown} payload
 * @returns {{ ok: boolean, version?: number, error?: string }}
 */
export function validateSpaceArchive(payload: unknown) : { ok: boolean, version?: number, error?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '这不是一个有效的空间包' }
  }
  const record = payload as Record<string, unknown>
  if (record.format !== SPACE_ARCHIVE_FORMAT) {
    return { ok: false, error: '这不是 Hira 的空间包（format 标识不匹配）' }
  }
  const version = Number(record.version)
  if (!Number.isFinite(version) || version <= 0) {
    return { ok: false, error: '空间包缺少有效的版本号' }
  }
  if (version > SPACE_ARCHIVE_VERSION) {
    return {
      ok: false,
      error: `空间包版本（v${version}）高于本应用支持的版本（v${SPACE_ARCHIVE_VERSION}），请先升级应用`
    }
  }
  const space = record.space
  if (!space || typeof space !== 'object' || Array.isArray(space)) {
    return { ok: false, error: '空间包缺少空间信息' }
  }
  const spaceRecord = space as Record<string, unknown>
  if (typeof spaceRecord.name !== 'string' || spaceRecord.name.trim() === '') {
    return { ok: false, error: '空间包的空间名称无效' }
  }
  const files = record.files
  if (files != null) {
    if (typeof files !== 'object' || Array.isArray(files)) {
      return { ok: false, error: '空间包的文件段格式不正确' }
    }
    const fileRecord = files as Record<string, unknown>
    for (const key of Object.keys(files)) {
      // 只允许白名单文件名，且值必须是字符串 —— 归档可能被手改，绝不让它写到目标目录之外。
      if (!SPACE_ARCHIVE_FILE_PATTERN.test(key)) {
        return { ok: false, error: `空间包包含不支持的文件：${key}` }
      }
      if (typeof fileRecord[key] !== 'string') {
        return { ok: false, error: `空间包的文件内容格式不正确：${key}` }
      }
    }
  }
  return { ok: true, version }
}

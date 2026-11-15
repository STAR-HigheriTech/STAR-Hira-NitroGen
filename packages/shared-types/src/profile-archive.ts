/**
 * Profile 归档（G1 导出 / G2 导入）—— **格式真源**。
 *
 * ── 为什么是「单文件 JSON」而不是 zip ──────────────────────────────
 * 仓库的 dependencies 里**没有任何压缩库**（archiver / yauzl / adm-zip 都没有）。
 * 为这一件事新增一个原生依赖，代价是：打包体积、跨平台构建、以及日后升级风险 ——
 * 而归档本身只是「一批小 JSON + 几张表的行」，用户几乎不会碰到体积瓶颈
 * （真正的重活是 favicon 缓存，已随 limit 明确处理）。
 * 因此选**一个自描述的 JSON 容器**：零依赖、可被人肉打开检查、跨版本可读。
 * 校验与版本判定都在这里一处（主进程导出/导入都引它，不手抄）。
 *
 * ── 排除了什么、为什么（写死在代码里，避免后人以为是漏了）─────────
 * 见 `PROFILE_ARCHIVE_EXCLUDED`。原则只有一条：**只带走属于这个用户的"数据"**，
 * 不带机器相关的运行时状态（Chromium 的 cookie/缓存/扩展目录）。
 */

/** 归档标识（`format` 字段）—— 用来一眼区分"本应用的配置包"与任意 JSON。 */
export const PROFILE_ARCHIVE_FORMAT = 'hira-profile-archive'

/** 归档版本。**只增不改**：老包必须永远能被新版本读进来。 */
export const PROFILE_ARCHIVE_VERSION = 1

/** 归档文件扩展名（保存对话框用）。 */
export const PROFILE_ARCHIVE_EXTENSION = 'hiraprofile'

/**
 * 归档要带的表 —— 判据是「这张表按 profile 分区」。
 *
 * 用**表名白名单**而不是"遍历 schema 里所有带 profile_id 的表"：
 * 导出/导入是数据迁移，多带一张不该带的表（或漏带一张）都是事故，
 * 白名单让"这个包到底装了什么"在代码里一眼可见、可审计。
 */
export const PROFILE_ARCHIVE_TABLES = Object.freeze([
  'bookmarks',
  'history',
  'history_visits',
  'downloads',
  'notes',
  'note_folders',
  // 集锦的引用边也随档案一起搬 —— 否则导入后「谁引用了谁」全丢，反链与 ↩N 徽标全空。
  // 该表含 profile_id，满足通用导出/导入的 `WHERE profile_id = ?` 取表约定。
  'note_refs',
  'totp_entries',
  'favicons',
  'passwords_meta',
  'passwords_never_save',
  'permissions',
  'search_history',
  'spaces'
])

/** 明确排除的表 + 理由（逐条写清，防止"看起来漏了"）。 */
export const PROFILE_ARCHIVE_EXCLUDED = Object.freeze({
  profiles: '配置档案自身的元数据。导入一律**新建**一个档案，绝不覆盖/复用既有档案的行。',
  kv: '全局键值存储（无 profile_id）—— 它不属于任何一个 profile，带进来会串味。',
  tabs: '已废弃（@deprecated，会话唯一真相源是 session.json），不再写入，也不导出。'
})

/**
 * 单包上限（字节）。超限**报错**而不是静默截断 ——
 * 截断等于悄悄丢用户数据，是比"导出失败"严重得多的结果。
 */
export const PROFILE_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024

/** profile 名称长度上限（与 domain-profile#profileUtil 的 NAME_MAX_LEN 同口径）。 */
const NAME_MAX_LEN = 40

/**
 * 建议的归档文件名（保存对话框默认名）—— 用 profile 名，抹掉文件系统非法字符。
 * @param {string} [name]
 * @returns {string}
 */
export function archiveFileNameFor(name: string) : string {
  const base = String(name || 'profile')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return `${base || 'profile'}.${PROFILE_ARCHIVE_EXTENSION}`
}

/**
 * 把名字收进 profile 名称长度上限，并叠一个后缀（如「 (导入)」）。
 * 超长时截断主体而不是后缀 —— 后缀是这次导入的语义标记，不能丢。
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
export function fitProfileName(base: string, suffix: string = '') : string {
  const clean = String(base || '').trim()
  const room = Math.max(1, NAME_MAX_LEN - suffix.length)
  const head = clean.length > room ? clean.slice(0, room) : clean
  return `${head}${suffix}`
}

/**
 * 校验一份归档载荷（**在动任何数据之前**调用）。
 *
 * 只做"能不能读懂、要不要拒绝"，不做任何修补 —— 结构不对就直接拒绝，
 * 给用户一句人话原因，而不是"导入一半失败"。
 * @param {unknown} payload
 * @returns {{ ok: boolean, version?: number, error?: string }}
 */
export function validateProfileArchive(payload: unknown) : { ok: boolean, version?: number, error?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '这不是一个有效的配置文件包' }
  }
  const record = payload as Record<string, unknown>
  if (record.format !== PROFILE_ARCHIVE_FORMAT) {
    return { ok: false, error: '这不是 Hira 的配置包（format 标识不匹配）' }
  }
  const version = Number(record.version)
  if (!Number.isFinite(version) || version <= 0) {
    return { ok: false, error: '配置包缺少有效的版本号' }
  }
  if (version > PROFILE_ARCHIVE_VERSION) {
    return {
      ok: false,
      error: `配置包版本（v${version}）高于本应用支持的版本（v${PROFILE_ARCHIVE_VERSION}），请先升级应用`
    }
  }
  const tables = record.tables
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    return { ok: false, error: '配置包缺少数据段' }
  }
  for (const name of PROFILE_ARCHIVE_TABLES) {
    const rows = (tables as Record<string, unknown>)[name]
    // 允许缺表（老版本包，或该表本就没有数据）—— 缺 = 空，不是错。
    if (rows == null) continue
    if (!Array.isArray(rows)) return { ok: false, error: `数据段「${name}」的格式不正确` }
  }
  const files = record.files
  if (files != null && (typeof files !== 'object' || Array.isArray(files))) {
    return { ok: false, error: '配置包的附件段格式不正确' }
  }
  return { ok: true, version }
}

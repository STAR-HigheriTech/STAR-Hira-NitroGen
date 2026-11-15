/**
 * ephemeral-cleanup —— 启动时清理**残留的临时（无痕）profile**。
 *
 * ── 为什么必须有 ──────────────────────────────────────────────────
 * 临时 profile 的生命周期本该是"窗口关了就没了"，但进程崩溃 / 强杀 / 掉电时它来不及
 * 被回收，于是 DB 里留下一条 `ephemeral = 1` 的行、磁盘上留下一个 `profiles/<id>` 目录。
 * 这类残留会一直累积（用户看不到，因为 `listVisible` 过滤了 internal，所以**永远不会
 * 被发现**）—— 恰是"用户看不见的垃圾数据"里最该主动清理的一类。
 *
 * 判据对齐 RT `profiles-controller/ephemeral.ts#cleanupStaleEphemeralProfiles`：
 * **按 profile 元数据里的 `ephemeral` 标记**，而不是猜目录名前缀或时间戳 ——
 * 标记是"创建时就写在真源里的意图"，前缀/时间戳都是对意图的二次推断。
 *
 * ── 为什么在 APPS 层而不是 profile 域里 ────────────────────────────
 * 域只回答"这个 profile 是什么"（`list()` 已带 `ephemeral` 字段）；而本步骤要同时动
 * **DB 行**（`profileService.remove`）与**磁盘目录**（`fs.rm`）——跨了存储与文件系统两界，
 * 属于组合根（APPS）的职责。域里加一个会删目录的函数，会让"纯数据域"不再纯粹。
 *
 * 调用时机：profile 服务就绪之后、用户可操作界面之前（见 main.js 的调用点）。
 */

const fs = require('fs')

interface EphemeralProfile {
  id?: string
  ephemeral?: boolean
}

interface EphemeralCleanupDeps {
  profileService?: {
    list?: () => EphemeralProfile[]
    remove?: (profileId: string) => unknown
  }
  resolveProfileDir?: (profileId: string) => string
  closeProfileDb?: (profileId: string) => void
}

function cleanupStaleEphemeralProfiles({
  profileService,
  resolveProfileDir,
  closeProfileDb
}: EphemeralCleanupDeps = {}): { removed: string[] } {
  const removed: string[] = []
  if (!profileService || typeof profileService.list !== 'function') return { removed }

  let all: EphemeralProfile[] = []
  try {
    all = profileService.list() || []
  } catch (error) {
    console.warn('[ephemeral] list failed:', error instanceof Error ? error.message : error)
    return { removed }
  }

  for (const profile of all) {
    if (!profile || !profile.ephemeral) continue
    const id = String(profile.id == null ? '' : profile.id)
    if (!id) continue

    // 先关库 → 再删数据目录 → 最后删 DB 行：反过来的话中途失败会留下"没有 DB 行、
    // 只有目录"的孤儿目录，而下次启动再也找不到它（`list()` 里已经没有这一条了）。
    try {
      if (typeof closeProfileDb === 'function') closeProfileDb(id)
    } catch (error) {
      console.warn(`[ephemeral] close db failed (${id}):`, error instanceof Error ? error.message : error)
    }
    try {
      const dir = typeof resolveProfileDir === 'function' ? resolveProfileDir(id) : ''
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      // 目录删不掉（被占用等）→ **不动 DB 行**，留给下次启动再试。
      console.warn(`[ephemeral] remove dir failed (${id}):`, error instanceof Error ? error.message : error)
      continue
    }

    if (typeof profileService.remove === 'function') {
      try {
        profileService.remove(id)
      } catch (error) {
        console.warn(`[ephemeral] remove record failed (${id}):`, error instanceof Error ? error.message : error)
        continue
      }
    }
    removed.push(id)
  }

  return { removed }
}

module.exports = { cleanupStaleEphemeralProfiles }

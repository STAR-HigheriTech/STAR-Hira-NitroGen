/**
 * 迁移源注册表
 *
 * 每条源描述「一类可搬的数据」以及它唯一的真实入口：
 *
 *   { id, label, accepts, pickHint, run(ctx, text) → Promise<Result> }
 *
 * Result: { ok: boolean, count?: number, cancelled?: boolean, message: string }
 *
 * 纪律：
 *   · 只调用已有的主进程 IPC（bookmarkImport / passwordImportCsv / passwordList），
 *     本文件不扫目录、不猜格式、不伪造「Hira Min 专有数据」。
 *   · 新增一种可迁移数据 = 在这里加一条；UI（migrate/index.js）自动多一行。
 *   · 文案只陈述真实能力（书签 HTML、密码 CSV），不宣称历史 / 设置也能导入。
 */

import type { MigrationResult, OnboardingContext } from '../types.js'
import { withTimeout } from '../async.js'

export interface MigrationSource {
  readonly id: string
  readonly label: string
  readonly accepts: string
  readonly pickHint: string
  readonly run: (context: OnboardingContext, text: string) => Promise<MigrationResult>
}

export const MIGRATION_SOURCES: readonly MigrationSource[] = Object.freeze([
  {
    id: 'bookmarks',
    label: '书签',
    accepts: '.html,.htm,text/html',
    pickHint: '选择书签 HTML 文件',
    run: importBookmarks
  },
  {
    id: 'passwords',
    label: '密码',
    accepts: '.csv,text/csv',
    pickHint: '选择密码 CSV 文件',
    run: importPasswords
  }
])

async function importBookmarks (ctx: OnboardingContext, text: string): Promise<MigrationResult> {
  const result = await withTimeout(
    ctx.rpc(ctx.IPC_ROUTES.bookmarkImport, { html: text }),
    20000,
    'bookmark import'
  )
  if (result && result.error) {
    return { ok: false, message: `导入失败：${result.error}` }
  }

  const imported = countOf(result?.imported)
  const skipped = countOf(result?.skipped)
  if (imported === 0) {
    return { ok: false, message: '没有解析到书签：文件内容不像 Netscape 书签 HTML。' }
  }
  return {
    ok: true,
    count: imported,
    message: skipped > 0
      ? `写入 ${imported} 条书签，另有 ${skipped} 条缺少链接被跳过。`
      : `写入 ${imported} 条书签。`
  }
}

async function importPasswords (ctx: OnboardingContext, text: string): Promise<MigrationResult> {
  let existing = 0
  try {
    const listed = await withTimeout(
      ctx.rpc(ctx.IPC_ROUTES.passwordList, {}),
      3000,
      'password count'
    )
    if (Array.isArray(listed)) existing = listed.length
  } catch (_) {
    // 查不到数量不阻断导入
  }

  if (existing > 0) {
    const go = window.confirm(
      `当前已保存 ${existing} 条密码。\n导入会覆盖「同网站 + 同用户名」的旧密码，其余条目保持不变。\n是否继续？`
    )
    if (!go) {
      return { ok: false, cancelled: true, message: '已取消，没有写入任何数据。' }
    }
  }

  const result = await withTimeout(
    ctx.rpc(ctx.IPC_ROUTES.passwordImportCsv, { content: text }),
    20000,
    'password import'
  )
  if (result && result.unsupported) {
    return { ok: false, message: '当前密码后端不支持批量导入，请切换到内置密码库后再试。' }
  }
  if (result && result.reason === 'encryption-unavailable') {
    return { ok: false, message: '本机加密组件不可用，已放弃本次导入，未写入任何数据。' }
  }

  const imported = countOf(result?.imported)
  const merged = countOf(result?.merged)
  const skipped = countOf(result?.skipped)
  const total = result && Number.isFinite(result.total) ? countOf(result.total) : imported + merged + skipped

  if (total === 0) {
    return { ok: false, message: '解析出 0 条密码：需要 url / username / password 三列。' }
  }
  if (imported + merged === 0) {
    return { ok: false, message: `共 ${total} 条记录，但都缺少网站地址或用户名，没有写入。` }
  }

  const parts = [`新增 ${imported} 条`]
  if (merged > 0) parts.push(`覆盖 ${merged} 条`)
  if (skipped > 0) parts.push(`跳过 ${skipped} 条`)
  return { ok: true, count: imported + merged, message: `密码${parts.join('，')}。` }
}

function countOf (value: unknown): number {
  const count = Number(value)
  return Number.isFinite(count) ? count : 0
}

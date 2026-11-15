/**
 * 密码管理面板尚未实现，本脚本提供一个临时的、安全的删除入口。
 *
 * 用法（PowerShell，在项目根，需先关闭应用避免 DB 锁）：
 *   # 只列出匹配的凭据（不删）
 *   node scripts/dev-delete-password.ts --dry-run
 *   node scripts/dev-delete-password.ts --dry-run --domain example.com
 *
 *   # 真正删除：删除该域名下 builtin 凭据（所有用户名）
 *   node scripts/dev-delete-password.ts --domain example.com
 *   # 仅删除该域名 + 指定用户名（用户名大小写不敏感）
 *   node scripts/dev-delete-password.ts --domain example.com --username Alice
 *
 * 说明：
 *   - 删除只匹配元数据行，不碰也不需要解密密文，绝对安全。
 *   - --db 可显式指定 hira-ng.db 路径；缺省时在 %APPDATA% 下自动发现。
 *   - domain 会按与保存一致的归一（剥协议/路径/端口、转小写）匹配。
 */
'use strict'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { eq, inArray } from 'drizzle-orm'
import { errorMessage } from './lib/type-guards.ts'

interface PasswordRow {
  id: string
  domain: string | null
  username: string | null
  backend?: string
}

const args = process.argv.slice(2)
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(name)

function findDbs(): string[] {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
  const found = new Set<string>()
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    let lvl1: string[] = []
    try { lvl1 = fs.readdirSync(root, { withFileTypes: true }).map((entry) => path.join(root, entry.name)) } catch {}
    const candidates = [...lvl1]
    for (const dir of lvl1) {
      try {
        for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
          candidates.push(path.join(dir, sub.name))
        }
      } catch { /* 第二层个别目录不可读则跳过 */ }
    }
    for (const dir of candidates) {
      const dbPath = path.join(dir, 'hira-ng.db')
      if (fs.existsSync(dbPath)) found.add(dbPath)
    }
  }
  return [...found]
}

async function main(): Promise<void> {
  const explicit = getArg('--db')
  const candidates = explicit ? [explicit] : findDbs()
  if (candidates.length === 0) {
    console.error('[dev-delete-password] 找不到 hira-ng.db，请用 --db <路径> 显式指定。')
    process.exit(1)
  }
  console.log('[dev-delete-password] 候选数据库:', candidates.join('\n                '))

  // 遍历每个候选库，统计 builtin 凭据数，挑有数据的那个（或第一个）
  const { createDb } = require('@hira-ng/infra-db')
  const { passwordsMeta } = require('@hira-ng/infra-db/schema')

  let target: string | null = null
  let targetCount = 0
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    try {
      const inst = createDb(c)
      const n = inst.db.select().from(passwordsMeta).where(eq(passwordsMeta.backend, 'builtin')).all().length
      inst.close()
      if (!target || n > targetCount) { target = c; targetCount = n }
    } catch { /* 该库打不开则跳过 */ }
  }
  if (!target) {
    console.error('[dev-delete-password] 候选库均打不开。')
    process.exit(1)
  }
  const dbPath = target
  console.log(`[dev-delete-password] 使用数据库: ${dbPath}（builtin 凭据 ${targetCount} 条）`)

  // 先列出当前打开数据库的线程隔离与只读安全：删除前先备份（同文件旁拷贝）
  if (!has('--no-backup')) {
    const bak = dbPath.replace(/\.db$/, '') + `.bak-${Date.now()}`
    try {
      fs.copyFileSync(dbPath, bak)
      console.log('[dev-delete-password] 已备份到', bak)
    } catch (error) {
      console.warn('[dev-delete-password] 备份失败（跳过）:', errorMessage(error))
    }
  }

  const { db, close } = createDb(dbPath)
  try {
    const rows = db.select().from(passwordsMeta)
      .where(eq(passwordsMeta.backend, 'builtin'))
      .all() as PasswordRow[]
    const norm = (value: unknown): string => String(value || '').trim().replace(/^[a-z]+:\/{2}/i, '').split('/')[0].split(':')[0].toLowerCase()
    const targetDomain = norm(getArg('--domain') || '')
    const targetUser = String(getArg('--username') || '').trim().toLowerCase()

    let matched = rows
    if (targetDomain) matched = matched.filter((row) => norm(row.domain) === targetDomain)
    if (targetUser) matched = matched.filter((row) => String(row.username || '').trim().toLowerCase() === targetUser)

    console.log(`[dev-delete-password] 匹配 ${matched.length} 条 builtin 凭据:`)
    for (const r of matched) console.log(`   - id=${r.id} domain=${r.domain} username=${r.username}`)

    const dry = has('--dry-run')
    if (dry) {
      console.log('[dev-delete-password] --dry-run 未执行删除。')
    } else {
      if (matched.length === 0) {
        console.log('[dev-delete-password] 无匹配，未删除。')
      } else {
        const ids = matched.map((row) => row.id)
        db.delete(passwordsMeta).where(inArray(passwordsMeta.id, ids)).run()
        console.log(`[dev-delete-password] 已删除 ${matched.length} 条。`)
      }
    }
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('[dev-delete-password] 失败:', e)
  process.exit(1)
})

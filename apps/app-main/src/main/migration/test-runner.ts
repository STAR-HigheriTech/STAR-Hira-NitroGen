#!/usr/bin/env node
/**
 * 迁移测试运行器 — 验证 4 套数据集 + 完整性校验 + 断电回滚。
 *
 * 用法: pnpm exec tsx apps/app-main/src/main/migration/test-runner.ts [dataset]
 *   dataset: empty | medium | largeHistory | dirty | all (默认 all)
 *
 * 解耦：仅依赖 infra-db + migration 模块，不依赖 domain/apps。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSqlite, ensureSchema } from '@hira-ng/infra-db'
import { runMigration } from './runner'
import { runIntegrityChecks } from './integrity'
import { DATASETS, writeDatasetToDir, type DatasetName, type MigrationDataset } from './datasets'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function runOne(name: DatasetName, genFn: () => MigrationDataset): Promise<boolean> {
  console.log(`\n━━━ DATASET: ${name} ━━━`)
  const sourceDir = tempDir('hira-mig-src-')
  const dbPath = path.join(tempDir('hira-mig-db-'), 'test.db')

  // 1. 生成数据集
  const dataset = genFn()
  writeDatasetToDir(sourceDir, dataset)
  console.log(`  source files written to: ${sourceDir}`)

  // 2. 运行迁移（计时）
  const start = Date.now()
  const result = await runMigration({
    sourceDir,
    dbPath,
    logger: {
      info: (message: string) => console.info(message),
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message)
    }
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(2)
  console.log(`  migration: ok=${result.ok}, errors=${result.errors.length}, time=${elapsed}s`)
  console.log(`  migrated:`, result.migrated)

  if (!result.ok) {
    console.error('  MIGRATION FAILED:', result.errors)
    return false
  }

  // 3. 完整性校验
  const sqlite = createSqlite(dbPath)
  ensureSchema(sqlite)
  const integrity = runIntegrityChecks(sqlite)
  sqlite.close()
  console.log(`  integrity: ${integrity.passed}/${integrity.total} passed, ${integrity.failed} failed`)
  if (integrity.failed > 0) {
    const failed = integrity.results.filter(r => !r.pass).slice(0, 10)
    console.error('  FAILED CHECKS:', failed.map(f => `${f.name}: ${f.detail}`))
  }

  // 性能断言
  if (name === 'medium' && parseFloat(elapsed) > 30) {
    console.error(`  PERF FAIL: medium dataset took ${elapsed}s (>30s)`)
    return false
  }
  if (name === 'largeHistory' && parseFloat(elapsed) > 120) {
    console.error(`  PERF FAIL: largeHistory dataset took ${elapsed}s (>120s)`)
    return false
  }

  return integrity.failed === 0
}

/** 断电回滚测试：迁移过程中模拟崩溃，验证 DB 无损坏 */
async function testPowerFailureRollback(): Promise<boolean> {
  console.log('\n━━━ POWER FAILURE ROLLBACK TEST ━━━')
  const sourceDir = tempDir('hira-pf-src-')
  const dbPath = path.join(tempDir('hira-pf-db-'), 'test.db')

  // 写一个有数据的数据集
  const dataset = DATASETS.medium()
  writeDatasetToDir(sourceDir, dataset)

  // 直接用 sqlite 模拟"迁移到一半崩溃"
  const sqlite = createSqlite(dbPath)
  ensureSchema(sqlite)

  sqlite.exec('BEGIN TRANSACTION')
  // 插入一部分书签（模拟迁移到一半）
  const stmt = sqlite.prepare('INSERT INTO bookmarks (id, parent_id, title, url, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 100; i++) {
    stmt.run(`bm-${i}`, null, `书签${i}`, `https://example.com/${i}`, Date.now(), Date.now())
  }
  // 不 COMMIT，直接关闭（模拟 kill -9）
  sqlite.close()

  // 重新打开，验证事务被回滚（bookmarks 应为空）
  const sqlite2 = createSqlite(dbPath)
  ensureSchema(sqlite2)
  const row = sqlite2.prepare('SELECT COUNT(*) AS c FROM bookmarks').get() as { c?: unknown } | undefined
  const count = Number(row?.c || 0)
  sqlite2.close()

  console.log(`  after crash: bookmarks count = ${count} (expected 0)`)
  if (count !== 0) {
    console.error('  ROLLBACK FAIL: bookmarks not rolled back after crash')
    return false
  }
  console.log('  ROLLBACK OK: transaction rolled back, DB intact')
  return true
}

async function main(): Promise<void> {
  const target = process.argv[2] || 'all'
  const all: DatasetName[] = ['empty', 'medium', 'largeHistory', 'dirty']
  const targets: string[] = target === 'all' ? all : [target]

  let allPass = true
  for (const name of targets) {
    const genFn = DATASETS[name as DatasetName]
    if (!genFn) {
      console.error(`Unknown dataset: ${name}. Available: ${all.join(', ')}`)
      process.exit(1)
    }
    const pass = await runOne(name as DatasetName, genFn)
    if (!pass) allPass = false
  }

  // 断电回滚测试
  const rollbackOk = await testPowerFailureRollback()
  if (!rollbackOk) allPass = false

  console.log(`\n${allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch((error: unknown) => { console.error(error); process.exit(1) })

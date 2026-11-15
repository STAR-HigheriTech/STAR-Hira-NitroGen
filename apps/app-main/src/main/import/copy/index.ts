/**
 * 源文件临时快照
 *
 * 为什么必须先复制再读：
 *   · 浏览器运行时对 `History` 持有写锁，直接打开既可能失败，也可能读到撕裂的页；
 *   · SQLite 的 WAL 模式下最新数据在 `-wal` 里，只拷主库会丢最近记录；
 *   · 真实数据目录是用户的浏览器 —— 任何写操作（哪怕 `PRAGMA`）都不可接受。
 * 因此：主库 + `-wal` + `-shm` 一起复制到系统临时目录，只读打开，用完立刻删。
 *
 * 临时目录用 `mkdtemp` 生成唯一名，多个 profile / 并发导入不会互相踩。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CopyResult {
  dir: string | null
  copied: Array<{ name: string; path: string }>
  missing: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function copyIfExists(src: string, dest: string): boolean {
  try {
    fs.copyFileSync(src, dest)
    return true
  } catch (_) {
    return false
  }
}

/**
 * @param {Array<{ name: string, src: string }>} files
 * @returns {{ dir: string|null, copied: Array<{name:string,path:string}>, missing: string[] }}
 */
export function copyFiles(files: Array<{ name: string; src: string }>): CopyResult {
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-import-'))
  } catch (e) {
    console.error('[browser-import] 创建临时目录失败:', errorMessage(e))
    return { dir: null, copied: [], missing: (files || []).map((f) => f && f.name).filter(Boolean) }
  }

  const copied: Array<{ name: string; path: string }> = []
  const missing: string[] = []
  for (const file of files || []) {
    if (!file || !file.name || !file.src) continue
    const dest = path.join(dir, file.name)
    if (!copyIfExists(file.src, dest)) {
      missing.push(file.name)
      continue
    }
    // 旁路文件缺席是正常情况（WAL 已 checkpoint 时 `-wal` / `-shm` 不存在）。
    copyIfExists(`${file.src}-wal`, `${dest}-wal`)
    copyIfExists(`${file.src}-shm`, `${dest}-shm`)
    copied.push({ name: file.name, path: dest })
  }
  return { dir, copied, missing }
}

/** 删除整份临时快照（幂等；失败只记日志，绝不影响导入结果）。 */
export function cleanup(dir: string | null | undefined): void {
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn('[browser-import] 清理临时目录失败:', errorMessage(e))
  }
}


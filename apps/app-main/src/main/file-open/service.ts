/**
 * main/file-open/service.ts —— 「文件 → 窗口」的执行层。
 *
 * 只做三件事，且顺序固定：
 *   1. stat（区分目录 / 不存在 / 普通文件）；
 *   2. 问 policy 该走哪条路（tab / external / reveal）；
 *   3. 执行：本窗口开标签、系统默认程序、或定位文件。
 *
 * ── 为什么 target 是 tab 时还要回退 ───────────────────────────────
 * 「浏览器能渲染」是 policy 的静态判断，但真实加载仍可能失败（权限、损坏的 pdf…）。
 * 失败时回退系统默认程序，用户至少能看到文件，而不是「拖了没反应」。
 *
 * ── 多文件 ────────────────────────────────────────────────────────
 * 第一个文件前台打开，其余后台打开（不抢焦点）。这是浏览器的通行语义：
 * 一次拖 10 张图不该让最后一个把前 9 个盖住。
 *
 * ── 窗口归属 ──────────────────────────────────────────────────────
 * 本层**不认识窗口**：注入的 tabManager 是 scoped 代理（见 ipc-routes.js），
 * 按当前 IPC 发送方自动落到发起拖放的那个窗口。导航兜底路径则由调用方
 * 直接传该 webContents 所属窗口的 tabManager。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createFileOpenPolicy,
  fileInfoOf,
  type FileOpenDecision,
  type FileOpenPolicy,
  type InspectedFileInfo
} from './policy'

export interface FileOpenResult {
  opened: number
  external: number
  skipped: number
}

export interface FileOpenTabManager {
  newTab(options: { url: string; openInBackground: boolean }): unknown | Promise<unknown>
}

export interface FileOpenServiceContext {
  tabManager?: FileOpenTabManager | null
}

interface FileSystemPort {
  stat(filePath: string): Promise<{ isDirectory(): boolean }>
}

interface ShellPort {
  showItemInFolder(filePath: string): void
  openPath(filePath: string): Promise<string>
}

interface FileOpenServiceOptions {
  policy?: FileOpenPolicy
  shell?: ShellPort
  fs?: FileSystemPort
}

export interface FileOpenService {
  openPaths(rawPaths: unknown, context?: FileOpenServiceContext): Promise<FileOpenResult>
  classify(filePath: string): Promise<FileOpenDecision>
  policy: FileOpenPolicy
}

const EMPTY_RESULT = (): FileOpenResult => ({ opened: 0, external: 0, skipped: 0 })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 去重 + 只保留绝对路径。
 * 拖放里理论上全是绝对路径，但 `webUtils.getPathForFile` 在极少数虚拟文件
 *（OneDrive 占位、压缩包内条目）上会给出空串甚至相对串 —— 这类直接丢弃。
 */
export function normalizePaths(raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const list = Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const p = item.trim()
    if (!p) continue
    if (!path.isAbsolute(p)) continue
    // Windows 下大小写不敏感：同一个文件被拖两次不该开两个标签
    const key = process.platform === 'win32' ? p.toLowerCase() : p
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 */
export function createFileOpenService({
  policy,
  shell,
  fs: fsModule
}: FileOpenServiceOptions = {}): FileOpenService {
  const openPolicy = policy || createFileOpenPolicy()
  const fsp = fsModule || fs
  // 延迟取 electron：本模块在单测 / 纯调用场景可以被 require 而不炸。
  const shellApi = shell || require('electron').shell as ShellPort

  async function inspect(filePath: string): Promise<InspectedFileInfo> {
    try {
      const stat = await fsp.stat(filePath)
      return { ...fileInfoOf(filePath), exists: true, isDirectory: stat.isDirectory() }
    } catch (_) {
      return { ...fileInfoOf(filePath), exists: false, isDirectory: false }
    }
  }

  function reveal(filePath: string): boolean {
    try {
      shellApi.showItemInFolder(filePath)
      return true
    } catch (e) {
      console.warn('[file-open] 定位文件失败:', filePath, errorMessage(e))
      return false
    }
  }

  async function openWithSystem(filePath: string): Promise<boolean> {
    try {
      const error = await shellApi.openPath(filePath)
      if (!error) return true
      console.warn('[file-open] 系统默认程序打开失败:', filePath, error)
    } catch (e) {
      console.warn('[file-open] 系统默认程序打开异常:', filePath, errorMessage(e))
    }
    // 默认程序都失败时至少把文件定位出来，别让这次拖放彻底无感。
    return reveal(filePath)
  }

  async function openInTab(
    info: InspectedFileInfo,
    options: { tabManager: FileOpenTabManager | null | undefined; openInBackground: boolean }
  ): Promise<boolean> {
    const { tabManager, openInBackground } = options
    if (!tabManager || typeof tabManager.newTab !== 'function') return false
    try {
      await tabManager.newTab({
        url: pathToFileURL(info.path).href,
        openInBackground
      })
      return true
    } catch (e) {
      console.warn('[file-open] 新标签打开失败（回退系统默认）:', info.path, errorMessage(e))
      return false
    }
  }

  /**
   * 打开一批文件。
   */
  async function openPaths(rawPaths: unknown, ctx: FileOpenServiceContext = {}): Promise<FileOpenResult> {
    const paths = normalizePaths(rawPaths)
    const result = EMPTY_RESULT()
    if (!paths.length) return result

    const tabManager = ctx && ctx.tabManager
    // 第一个**成功打开**的占前台；之后一律后台（避免连拖多个把焦点甩到最后）。
    let hasForeground = false

    for (const filePath of paths) {
      const info = await inspect(filePath)
      if (!info.exists) {
        result.skipped += 1
        continue
      }

      const decision = openPolicy.classify(info)
      const provider = decision.provider && decision.provider.open ? decision.provider : null
      const providerOpen = provider ? provider.open : null
      const providerId = provider ? provider.id : ''

      // 扩展点优先：插件可以完全接管某类文件（例如内置解压预览）。
      if (providerOpen) {
        try {
          const handled = await providerOpen(info, {
            tabManager,
            openInBackground: hasForeground
          })
          if (handled) {
            result.opened += 1
            hasForeground = true
            continue
          }
        } catch (e) {
          console.warn(`[file-open] provider "${providerId}" 打开失败（继续走默认）:`, errorMessage(e))
        }
      }

      if (decision.target === 'tab') {
        const ok = await openInTab(info, { tabManager, openInBackground: hasForeground })
        if (ok) {
          result.opened += 1
          hasForeground = true
          continue
        }
        // 标签打开失败 → 系统默认
        if (await openWithSystem(filePath)) {
          result.external += 1
          hasForeground = true
        } else {
          result.skipped += 1
        }
        continue
      }

      if (decision.target === 'reveal') {
        // 可执行文件：定位而不执行（见 policy.js 的 EXECUTABLE_EXTENSIONS 说明）
        reveal(filePath)
        result.skipped += 1
        continue
      }

      if (await openWithSystem(filePath)) {
        result.external += 1
        hasForeground = true
      } else {
        result.skipped += 1
      }
    }

    return result
  }

  /** 单文件判定（诊断 / 未来右键菜单「用…打开」可复用）。 */
  async function classify(filePath: string): Promise<FileOpenDecision> {
    return openPolicy.classify(await inspect(filePath))
  }

  return { openPaths, classify, policy: openPolicy }
}


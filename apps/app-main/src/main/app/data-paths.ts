/**
 * app/data-paths.ts — 用户数据目录的**唯一真源**。
 *
 * 为什么要这一层：
 *   Electron 默认把 userData 放在 `%APPDATA%\<package.json name>`，一旦改包名/产品名，
 *   数据就"搬家"到另一个目录，且各个服务里散落的 `app.getPath('userData')` 会各自
 *   指向不同位置。这里在 **ready 之前**把路径一次性定死，下游（设置、数据库、插件、
 *   主题资产、窗口几何、密码工具……）继续读 `app.getPath('userData')` 即可，
 *   **不需要任何一个消费方知道厂商目录 / 产品目录的存在**。
 *
 * 排布与 Hira 一致（`main/main.js` 里的 setPath 同款）：
 *
 *   %APPDATA%\STAR_HigheriTech\STAR Hira NitroGen\            ← userData（设置 / 数据库 / 插件 …）
 *   %APPDATA%\STAR_HigheriTech\STAR Hira NitroGen-development\ ← 开发态，绝不污染正式数据
 *
 * 其余 Electron 目录（sessionData / logs / crashDumps / Crashpad）默认就派生自
 * userData，改 userData 即随之落进同一个文件夹 —— 所以这里**只设一处**，不逐个搬。
 *
 * 时序：必须在 `app.whenReady()` 之前调用，且必须早于任何读 userData 的代码
 * （preboot 的 earlyBootSettings 就在 ready 之前直读设置文件）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import { isDevRuntime } from './runtime-mode'

const { APP_NAME } = require('@hira-ng/shared-types/src/associations.mjs') as { APP_NAME: string }

export interface AppDataPathsResult {
  vendorDir: string
  productDir: string
  userDataPath: string
  isDevelopment: boolean
}

export interface AppDataPathsOptions {
  app: App
  isDevelopment?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 厂商目录：所有 STAR HigheriTech 产品并列在同一层。 */
export const VENDOR_DIR = 'STAR_HigheriTech'

/** 产品目录名 —— 与 electron-builder 的 `build.productName` 保持一致。 */
export const PRODUCT_DIR = APP_NAME

/** 开发态后缀（与 Hira 同款）：dev 用独立目录，避免开发调试写坏正式数据。 */
const DEV_SUFFIX = '-development'

/**
 * 历史落点（Electron 默认 userData，改名前的包名 / 产品名）。
 * 只在**新目录还不存在**时做一次性搬家，命中即止。
 */
const LEGACY_PRODUCT_DIR_NAMES = ['HiraNG']
const LEGACY_DIR_NAMES = ['hira-ng', 'Hira NG']

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把旧 userData 整体搬到新位置（rename 同卷瞬时完成，不复制字节）。
 *
 * @param {string} appData
 * @param {string} targetDir
 * @returns {string | null} 成功搬走的旧目录，未搬返回 null
 */
function migrateLegacyUserData(appData: string, targetDir: string, isDevelopment: boolean): string | null {
  if (fs.existsSync(targetDir)) return null
  const legacyDirs = [
    ...LEGACY_PRODUCT_DIR_NAMES.map((name) => path.join(appData, VENDOR_DIR, name + (isDevelopment ? DEV_SUFFIX : ''))),
    ...(isDevelopment ? [] : LEGACY_DIR_NAMES.map((name) => path.join(appData, name)))
  ]
  for (const legacyDir of legacyDirs) {
    if (!fs.existsSync(legacyDir)) continue
    try {
      ensureDir(path.dirname(targetDir))
      fs.renameSync(legacyDir, targetDir)
      console.log('[paths] userData migrated:', legacyDir, '->', targetDir)
      return legacyDir
    } catch (e) {
      // 跨卷 / 被占用：放弃搬家（宁可让用户手动处理，也不要在启动路径上做长拷贝）
      console.warn('[paths] userData migrate skipped:', legacyDir, errorMessage(e))
    }
  }
  return null
}

/**
 * ready 之前调用：定名 + 定 userData，返回本次生效的目录信息。
 *
 * @param {{ app: import('electron').App, isDevelopment?: boolean }} deps
 * @returns {{ vendorDir: string, productDir: string, userDataPath: string, isDevelopment: boolean }}
 */
export function applyAppDataPaths({ app, isDevelopment = isDevRuntime() }: AppDataPathsOptions): AppDataPathsResult {
  const vendorDir = path.join(app.getPath('appData'), VENDOR_DIR)
  const userDataPath = path.join(vendorDir, PRODUCT_DIR + (isDevelopment ? DEV_SUFFIX : ''))

  // 先定名：`app.getName()` 是窗口标题 / 通知 / updater 缓存目录 / 日志归属的共同来源，
  // 打包态由 productName 决定，开发态只能靠这里对齐，否则两态跑出两个名字。
  app.setName(PRODUCT_DIR)

  // 开发态只迁移上一代开发目录，绝不碰正式数据；正式态同时迁移历史 Electron 默认目录。
  migrateLegacyUserData(app.getPath('appData'), userDataPath, isDevelopment)
  ensureDir(userDataPath)
  app.setPath('userData', userDataPath)

  return {
    vendorDir,
    productDir: PRODUCT_DIR,
    userDataPath,
    isDevelopment
  }
}


/**
 * app/runtime-identity.ts —— OS 身份与集成能力的唯一装配点。
 *
 * 业务模块不再自行读取 process.execPath / app.isPackaged 来决定“要不要写系统”。
 * 开发态使用独立 AUMID，并整体关闭会落到用户系统的快捷方式、协议与任务栏任务；
 * 打包态才返回安装后的 STAR Hira NitroGen.exe 身份。
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { isPackagedRuntime, isUnpackedBuildExecutable } from './runtime-mode'

const { APP_AUMID, APP_NAME } = require('@hira-ng/shared-types/src/associations.mjs') as {
  APP_AUMID: string
  APP_NAME: string
}

export interface RuntimeIdentity {
  packaged: boolean
  development: boolean
  productName: string
  displayName: string
  executablePath: string
  executableName: string
  executableDirectory: string
  appRoot: string
  appUserModelId: string
  pwaAumidPrefix: string
  systemIntegrationEnabled: boolean
  systemIntegrationReason: string
  windowIconPath: string | null
}

function safeAppRoot(): string {
  try {
    return String(app.getAppPath() || process.cwd())
  } catch (_) {
    return process.cwd()
  }
}

export function getRuntimeIdentity(): RuntimeIdentity {
  const packaged = isPackagedRuntime()
  const executablePath = String(process.execPath || '')
  const executableName = path.basename(executablePath || (packaged ? `${APP_NAME}.exe` : 'electron.exe'))
  const appRoot = safeAppRoot()
  const appUserModelId = packaged ? APP_AUMID : `${APP_AUMID}.development`
  const devIcon = path.join(appRoot, 'build', 'icon.ico')
  const windowIconPath = packaged
    ? executablePath
    : (fs.existsSync(devIcon) ? devIcon : null)

  return {
    packaged,
    development: !packaged,
    productName: APP_NAME,
    displayName: packaged ? APP_NAME : `${APP_NAME} Development`,
    executablePath,
    executableName,
    executableDirectory: executablePath ? path.dirname(executablePath) : '',
    appRoot,
    appUserModelId,
    pwaAumidPrefix: `${appUserModelId}.pwa.`,
    systemIntegrationEnabled: packaged,
    systemIntegrationReason: packaged
      ? ''
      : isUnpackedBuildExecutable(executablePath)
        ? '检测到未安装的构建产物（win-unpacked），已禁用系统快捷方式、关联与任务栏写入'
        : '开发模式不会写入系统快捷方式、文件关联、协议处理器或任务栏任务',
    windowIconPath
  }
}

/**
 * app/runtime-mode.ts —— 「打包态 / 开发态」的**唯一判据**。
 *
 * 开发态里 exe 是 node_modules 下的 electron.exe，任何写注册表、写快捷方式、
 * 注册协议或配置任务栏身份的动作都只会把开发运行时泄漏进用户系统。这里把
 * Electron 的多个信号合并成一条保守结论：只有「app.isPackaged + 非 defaultApp
 * + 可执行文件不是 Electron」同时成立，才允许 OS 集成。
 */

import { app } from 'electron'

const ELECTRON_DEV_EXECUTABLE_RE = /(?:^|[\\/])node_modules[\\/]electron[\\/]dist[\\/]electron(?:\.exe)?$/i
const UNPACKED_BUILD_EXECUTABLE_RE = /(?:^|[\\/])(?:dist|release|build)[\\/]win-(?:unpacked|arm64-unpacked)[\\/][^\\/]+$/i

export function isElectronDevelopmentExecutable(execPath: string = process.execPath): boolean {
  return ELECTRON_DEV_EXECUTABLE_RE.test(String(execPath || ''))
}

/** electron-builder --dir / pack 的未安装产物，也不能写用户系统。 */
export function isUnpackedBuildExecutable(execPath: string = process.execPath): boolean {
  return UNPACKED_BUILD_EXECUTABLE_RE.test(String(execPath || ''))
}

/** 是否运行在真正的打包产物里。任何异常都按开发态处理，绝不冒险写系统。 */
export function isPackagedRuntime(): boolean {
  try {
    if (process.defaultApp === true) return false
    if (app.isPackaged !== true) return false
    return !isElectronDevelopmentExecutable(process.execPath) && !isUnpackedBuildExecutable(process.execPath)
  } catch (_) {
    return false
  }
}

/** 是否运行在开发态（`electron .` / `electron-vite dev`）。 */
export function isDevRuntime(): boolean {
  return !isPackagedRuntime()
}

/**
 * IPC · 配置档案归档（G1 导出 / G2 导入）
 *
 * 这一层只做两件事：**弹原生文件对话框** + 把路径交给 `profile-archive` 引擎。
 * 归档格式、表白名单、校验与落库/落盘全在别处：
 *   · 格式真源  → `@hira-ng/shared-types/src/profile-archive.mjs`
 *   · 搬运引擎  → `main/profile-archive.js`
 * 于是这里不认识任何表名、也不认识任何一条业务规则 —— 与 default-browser 同一种分工。
 *
 * ── 为什么动作结果要回话 ──────────────────────────────────────────
 * 导出/导入是"看得见结果"的动作（去了哪个文件、成了哪个档案、为什么没成）。
 * 对话框一取消就该安静收场；出了错必须把原因交回设置页，而不是吞掉。
 * 因此 handler 一律把异常**降级成 `{ ok:false, error }`**，绝不上抛 ——
 * 上抛会让设置页那一整块 action 控件渲染失败（与 default-browser 同一条纪律）。
 */

import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import {
  createSettingsActionPort,
  SETTINGS_ACTION_ROUTES,
  type SettingsActionPort
} from '../settings/actions'
const {
  PROFILE_ARCHIVE_EXTENSION,
  archiveFileNameFor
} = require('@hira-ng/shared-types/src/profile-archive.mjs') as {
  PROFILE_ARCHIVE_EXTENSION: string
  archiveFileNameFor(name: unknown): string
}

interface ProfileServicePort { getActive(): { id?: unknown; name?: unknown } | null | undefined }
interface ProfileArchivePort {
  exportToFile(profileId: string, filePath: string): { path: string }
  readArchiveFile(filePath: string): unknown
  importArchive(payload: unknown): { profileId: string; name: string }
}

interface ProfileArchiveIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['app']
  profileArchive?: ProfileArchivePort | null
  profileService?: ProfileServicePort | null
  settingsActions?: SettingsActionPort | null
}

/** 原生对话框的父窗口：取当前聚焦窗口；取不到时退化为无父（对话框仍可用）。 */
function focusedWindow(): BrowserWindow | undefined {
  try { return BrowserWindow.getFocusedWindow() || undefined } catch (_) { return undefined }
}

function showSave(win: BrowserWindow | undefined, options: SaveDialogOptions) {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}
function showOpen(win: BrowserWindow | undefined, options: OpenDialogOptions) {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

/**
 * 设置页动作与 AI 共用的执行器。
 *
 * 文件对话框仍属于主进程交互层；归档读写继续交给 profileArchive，避免把业务规则
 * 搬到这里。返回结构沿用设置页已有的 `{ ok, message, error, canceled }` 契约。
 */
export function createProfileArchiveActions(profileArchive: ProfileArchivePort, profileService?: ProfileServicePort | null): SettingsActionPort {
  return createSettingsActionPort({
    [SETTINGS_ACTION_ROUTES.exportProfile]: async () => {
      const active = profileService && typeof profileService.getActive === 'function'
        ? profileService.getActive()
        : null
      const profileId = active && typeof active.id === 'string' ? active.id : 'default'

      const res = await showSave(focusedWindow(), {
        title: '导出配置档案',
        defaultPath: archiveFileNameFor(active && active.name),
        filters: [{ name: 'Hira 配置包', extensions: [PROFILE_ARCHIVE_EXTENSION] }]
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }

      try {
        const out = profileArchive.exportToFile(profileId, res.filePath)
        return { ok: true, path: out.path, message: `已导出到 ${out.path}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '导出失败' }
      }
    },
    [SETTINGS_ACTION_ROUTES.importProfile]: async () => {
      const res = await showOpen(focusedWindow(), {
        title: '导入配置档案',
        properties: ['openFile'],
        filters: [
          { name: 'Hira 配置包', extensions: [PROFILE_ARCHIVE_EXTENSION] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }

      try {
        const payload = profileArchive.readArchiveFile(res.filePaths[0])
        const out = profileArchive.importArchive(payload)
        return {
          ok: true,
          profileId: out.profileId,
          message: `已导入为新档案「${out.name}」，可在配置文件切换器中启用。`
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '导入失败' }
      }
    }
  })
}

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, profileArchive:any, profileService:any }} ctx
 */
export function registerProfileArchiveIpc(typedMain: IpcTypedMain, ctx: ProfileArchiveIpcContext): void {
  const { routes, schemas, profileArchive, profileService } = ctx || {}
  if (!typedMain || !profileArchive || !routes || !schemas) return
  if (!schemas.exportProfile || !schemas.importProfile) return
  const actions = ctx.settingsActions || createProfileArchiveActions(profileArchive, profileService)

  typedMain.handle(routes.appExportProfile, {
    requestSchema: schemas.exportProfile.request,
    responseSchema: schemas.exportProfile.response,
    handler: () => actions.run(routes.appExportProfile)
  })

  typedMain.handle(routes.appImportProfile, {
    requestSchema: schemas.importProfile.request,
    responseSchema: schemas.importProfile.response,
    handler: () => actions.run(routes.appImportProfile)
  })
}


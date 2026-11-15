/**
 * IPC · 空间归档（导出 / 导入）
 *
 * 与 `ipc/profile-archive.js` 完全同构的薄壳：只弹原生对话框 + 转调引擎。
 *   · 格式真源  → `@hira-ng/shared-types/src/space-archive.mjs`
 *   · 搬运引擎  → `main/space-archive.js`
 *   · 变更广播  → `ipc/space-events.js`（与 CRUD 写路径共用同一个出口）
 *
 * 动作结果一律回话：取消 → `{ ok:false, canceled:true }` 安静收场；
 * 异常 → 降级成 `{ ok:false, error }`，绝不上抛（上抛会把空间页整块渲染打崩）。
 */

import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import type { SpaceChangeNotifier } from './space-events'
const {
  SPACE_ARCHIVE_EXTENSION,
  spaceArchiveFileNameFor
} = require('@hira-ng/shared-types/src/space-archive.mjs') as {
  SPACE_ARCHIVE_EXTENSION: string
  spaceArchiveFileNameFor(name: unknown): string
}

interface SpaceServicePort { get(profileId: string, spaceId: string): { id: unknown; name: unknown; profileId: unknown } | null | undefined }
interface SpaceArchivePort {
  exportToFile(profileId: string, spaceId: string, filePath: string): { path: string }
  readArchiveFile(filePath: string): unknown
  importArchive(profileId: string, payload: unknown): { spaceId: string; name: string }
}

interface SpaceArchiveIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['space']
  spaceArchive?: SpaceArchivePort | null
  spaceService?: SpaceServicePort | null
  notifySpaceChanged?: SpaceChangeNotifier
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
 * @param {{ handle: Function }} typedMain
 * @param {{
 *   routes: any,
 *   schemas: any,
 *   spaceArchive: any,
 *   spaceService: any,
 *   notifySpaceChanged: (reason: string, space: any) => void
 * }} ctx
 */
export function registerSpaceArchiveIpc(typedMain: IpcTypedMain, ctx: SpaceArchiveIpcContext): void {
  const { routes, schemas, spaceArchive, spaceService, notifySpaceChanged } = ctx || {}
  if (!typedMain || !spaceArchive || !routes || !schemas) return
  if (!schemas.exportSpace || !schemas.importSpace) return

  const notify = typeof notifySpaceChanged === 'function' ? notifySpaceChanged : () => {}

  typedMain.handle(routes.spaceExport, {
    requestSchema: schemas.exportSpace.request,
    responseSchema: schemas.exportSpace.response,
    handler: async (_e, req) => {
      const space = spaceService && typeof spaceService.get === 'function'
        ? spaceService.get(req.profileId, req.spaceId)
        : null
      if (!space) return { ok: false, error: '要导出的空间不存在' }

      const res = await showSave(focusedWindow(), {
        title: '导出空间',
        defaultPath: spaceArchiveFileNameFor(space.name),
        filters: [{ name: 'Hira 空间包', extensions: [SPACE_ARCHIVE_EXTENSION] }]
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }

      try {
        const out = spaceArchive.exportToFile(req.profileId, req.spaceId, res.filePath)
        return { ok: true, path: out.path, message: `已导出到 ${out.path}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '导出失败' }
      }
    }
  })

  typedMain.handle(routes.spaceImport, {
    requestSchema: schemas.importSpace.request,
    responseSchema: schemas.importSpace.response,
    handler: async (_e, req) => {
      const res = await showOpen(focusedWindow(), {
        title: '导入空间',
        properties: ['openFile'],
        filters: [
          { name: 'Hira 空间包', extensions: [SPACE_ARCHIVE_EXTENSION] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }

      try {
        // 先读 + 校验，再动数据（校验不过直接抛，绝不半灌）。
        const payload = spaceArchive.readArchiveFile(res.filePaths[0])
        const out = spaceArchive.importArchive(req.profileId, payload)
        const created = spaceService && typeof spaceService.get === 'function'
          ? spaceService.get(req.profileId, out.spaceId)
          : { id: out.spaceId, profileId: req.profileId }
        notify('imported', created)
        return { ok: true, spaceId: out.spaceId, name: out.name, message: `已导入空间「${out.name}」` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '导入失败' }
      }
    }
  })
}


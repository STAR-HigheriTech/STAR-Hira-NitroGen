/**
 * IPC · 截图标注编辑器域（TypeScript）
 *
 * 三种截图方式（可见区域 / 整页 / 选区）取到图后都进同一个标注窗口。本域只做三件事：
 *   load —— 按 captureId 从主进程暂存里**取走**底图（取走即删，不需要 release 协议）
 *   copy —— 标注后重新编码的 PNG → 系统剪贴板
 *   save —— 标注后重新编码的 PNG → 「另存为」对话框（父窗口 = 调用方窗口）
 *
 * 二进制一律走 `z.unknown()`（Electron 结构化克隆直接透传 Uint8Array）；
 * 取图 / 暂存 / 落盘策略全部在 `main/capture-editor.js`，这里只做转发与父窗口解析。
 */

import { errorMessage, type IpcSchemas, type IpcTypedMain } from './types'
import type { IpcMainInvokeEvent } from 'electron'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['captureEditor']
}

export function registerCaptureIpc(typedMain: IpcTypedMain, { routes, schemas }: Deps): void {
  if (!routes || !schemas) return
  const { BrowserWindow } = require('electron')
  const { takeCapture, copyPngToClipboard, savePngToFile } = require('../capture-editor')

  if (routes.captureEditorLoad && schemas.load) {
    typedMain.handle(routes.captureEditorLoad, {
      requestSchema: schemas.load.request,
      responseSchema: schemas.load.response,
      handler: async (_e, req) => {
        const taken = takeCapture(String(req.captureId || ''))
        if (!taken) return { ok: false, reason: 'expired' }
        return { ok: true, bytes: taken.bytes }
      }
    })
  }

  if (routes.captureEditorCopy && schemas.copy) {
    typedMain.handle(routes.captureEditorCopy, {
      requestSchema: schemas.copy.request,
      responseSchema: schemas.copy.response,
      handler: async (_e, req) => ({ ok: copyPngToClipboard(req.bytes) })
    })
  }

  if (routes.captureEditorSave && schemas.save) {
    typedMain.handle(routes.captureEditorSave, {
      requestSchema: schemas.save.request,
      responseSchema: schemas.save.response,
      handler: async (event, req) => {
        const owner = BrowserWindow.fromWebContents((event as IpcMainInvokeEvent).sender)
        try {
          return await savePngToFile(owner || undefined, req.bytes, req.suggestedName)
        } catch (error) {
          return { ok: false, reason: errorMessage(error) || 'save-failed' }
        }
      }
    })
  }
}


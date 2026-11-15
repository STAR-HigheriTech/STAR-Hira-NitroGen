/**
 * IPC · Print 域（TypeScript）
 *
 * 打印预览窗口只持有 jobId，所有重活都在 `main/print/service.ts`：
 *   job      —— 取元数据（标题 / URL），预览页首帧用
 *   render   —— 按选项渲染 PDF，返回 `hira://print-pdf/<jobId>` 地址
 *   commit   —— 把**源页面**的 webContents 交给系统打印对话框
 *   savePdf  —— 渲染后另存为 PDF（保存对话框的父窗口是调用方，即预览窗口）
 *
 * 这里只做转发与「父窗口解析」，不含任何打印策略。
 */

import type { IpcMainInvokeEvent } from 'electron'
import type {
  PrintService
} from '../print/service'
import { errorMessage, type IpcSchemas, type IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['print']
  printService?: PrintService | null
}

export function registerPrintIpc(typedMain: IpcTypedMain, { routes, schemas, printService }: Deps): void {
  if (!routes || !schemas || !printService) return
  const { BrowserWindow } = require('electron')

  if (routes.printJob && schemas.job) {
    typedMain.handle(routes.printJob, {
      requestSchema: schemas.job.request,
      responseSchema: schemas.job.response,
      handler: async (_e, req) => ({ job: printService.getJob(String(req.jobId)) })
    })
  }

  if (routes.printRender && schemas.render) {
    typedMain.handle(routes.printRender, {
      requestSchema: schemas.render.request,
      responseSchema: schemas.render.response,
      handler: async (_e, req) => {
        const jobId = String(req.jobId)
        try {
          const { job } = await printService.render(jobId, req.options)
          return { ok: true, pdfUrl: `hira://print-pdf/${job.id}`, job }
        } catch (error) {
          return { ok: false, reason: errorMessage(error) || 'render-failed' }
        }
      }
    })
  }

  if (routes.printCommit && schemas.commit) {
    typedMain.handle(routes.printCommit, {
      requestSchema: schemas.commit.request,
      responseSchema: schemas.commit.response,
      handler: async (_e, req) => {
        try {
          return await printService.commit(String(req.jobId), req.options)
        } catch (error) {
          return { ok: false, reason: errorMessage(error) || 'print-failed' }
        }
      }
    })
  }

  if (routes.printSavePdf && schemas.savePdf) {
    typedMain.handle(routes.printSavePdf, {
      requestSchema: schemas.savePdf.request,
      responseSchema: schemas.savePdf.response,
      handler: async (event, req) => {
        const owner = BrowserWindow.fromWebContents((event as IpcMainInvokeEvent).sender)
        try {
          return await printService.savePdf(String(req.jobId), req.options, owner || undefined)
        } catch (error) {
          return { ok: false, reason: errorMessage(error) || 'save-failed' }
        }
      }
    })
  }

  if (routes.printClose && schemas.close) {
    typedMain.handle(routes.printClose, {
      requestSchema: schemas.close.request,
      responseSchema: schemas.close.response,
      handler: async (_e, req) => {
        try {
          printService.closeJob(String(req.jobId))
        } catch {
          /* 关闭释放失败不影响窗口关闭 */
        }
        return { ok: true }
      }
    })
  }
}


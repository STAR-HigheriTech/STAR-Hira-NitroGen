import { z } from 'zod'
// 纸张 / 边距词表的唯一真源（主进程收口与预览页下拉共用同一份）。
const { PRINT_PAGE_SIZES, PRINT_MARGIN_MODES } = require('@hira-ng/shared-types/src/print.mjs')

/**
 * Print 域契约。
 *
 * 四条路由都围绕同一个 `jobId`：
 *   1. 预览窗口先从快捷键 / 菜单被打开（jobId 由主进程在窗口 payload 里给出）；
 *   2. 预览页 mount 时 `printJob` 取标题 / URL 画首帧；
 *   3. 选项变化 → `printRender` 换一份带新 rev 的 PDF 地址（pdfjs 直接读）；
 *   4. 点「打印」→ `printCommit`；点「另存为 PDF」→ `printSavePdf`。
 *
 * 选项对象**全部字段可选**：预览页可以只发改动的那一项，收口与默认值
 * 只在主进程 `normalizePrintOptions` 里做一次（不在两边各写一份默认值）。
 */
const printOptionsSchema = z
  .object({
    pageSize: z.enum(PRINT_PAGE_SIZES).optional(),
    landscape: z.boolean().optional(),
    printBackground: z.boolean().optional(),
    margins: z.enum(PRINT_MARGIN_MODES).optional(),
    scale: z.number().optional()
  })
  .optional()

const jobMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  createdAt: z.number(),
  rev: z.number()
})

const printSchemas = Object.freeze({
  job: Object.freeze({
    request: z.object({ jobId: z.string().min(1) }),
    response: z.object({ job: jobMetaSchema.nullable() })
  }),
  render: Object.freeze({
    request: z.object({ jobId: z.string().min(1), options: printOptionsSchema }),
    response: z.object({
      ok: z.boolean(),
      pdfUrl: z.string().optional(),
      job: jobMetaSchema.optional(),
      reason: z.string().optional()
    })
  }),
  commit: Object.freeze({
    request: z.object({ jobId: z.string().min(1), options: printOptionsSchema }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  }),
  savePdf: Object.freeze({
    request: z.object({ jobId: z.string().min(1), options: printOptionsSchema }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      filePath: z.string().optional(),
      reason: z.string().optional()
    })
  }),
  close: Object.freeze({
    request: z.object({ jobId: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  })
})

export { printSchemas }


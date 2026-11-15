import { z } from 'zod'

/**
 * 契约 · 浏览器界面叠加编辑模式
 *
 * 几何上报覆盖 navbar / rail 内部控件，以及 chrome 整栏、面板列和 Web Sidebar。
 *
 * 只有两条 invoke 通道需要 schema（进入/退出编辑模式、查询是否在编辑中）；
 * 几何上报 `buttons-edit:zone` 走单向 send（ipcMain.on），与其它浮层通道同口径 ——
 * 高频、fire-and-forget，不做逐帧校验。
 */
const buttonsEditSchemas = Object.freeze({
  setActive: Object.freeze({
    request: z.object({ active: z.boolean() }),
    response: z.object({ active: z.boolean() })
  }),
  isActive: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ active: z.boolean() })
  }),
  // 「请重新量一次几何」（编辑浮层 → 主进程 → 外壳 / rail）。
  // 主进程只负责转成窗口级事件，不持有任何几何状态。
  remeasure: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  })
})

export { buttonsEditSchemas }


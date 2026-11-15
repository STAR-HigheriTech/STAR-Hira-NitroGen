import { z } from 'zod'
import path from 'node:path'

/**
 * Files 契约 —— 「系统文件拖入浏览器窗口」的唯一上报口。
 *
 * 谁在发：三个 preload（外壳 / 面板 / 标签网页）共用同一份 file-drop 模块，
 * 因此**窗口里的任何区域**拖入文件都落到这一条通道上，落点窗口由 sender 解析
 * （见 window-runtime-registry），不在这里传窗口 id —— 渲染层无权指定别的窗口。
 *
 * 为什么是 send 语义的 invoke：打开是 fire-and-forget，但 invoke 能让
 * 「主进程没能处理」在开发期立刻暴露（渲染侧 catch 掉即可，不影响交互）。
 */
const filesSchemas = Object.freeze({
  drop: Object.freeze({
    // 只接受绝对路径：相对路径在拖放里没有意义，也无法安全解析。
    request: z.object({
      paths: z.array(z.string().min(1).max(4096).refine((value: string) => path.isAbsolute(value))).min(1).max(64)
    }),
    // 三个计数只用于诊断（目前渲染侧不消费）；真正的效果是「文件被打开了」。
    response: z.object({
      opened: z.number().int().nonnegative(),
      external: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative()
    })
  })
})

export { filesSchemas }


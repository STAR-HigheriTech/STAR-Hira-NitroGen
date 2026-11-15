import { z } from 'zod'

/**
 * App 契约 —— 进程指标（Chromium 风格任务管理器）。
 *
 * 数据只能来自主进程：`app.getAppMetrics()` 给出每个进程的 type/CPU/内存，
 * 再配合各 WebContents 的 OS 进程号与标签标题，才能拼出「哪个标签占了多少内存」。
 * 渲染进程无论怎么算都拿不到这些数字，因此绝不在这里做任何估算。
 *
 * 内存口径（独占内存，非工作集）见 `main/process-memory.ts` —— 与标签 hover 预览同源。
 */
const appMetricItem = z.object({
  pid: z.number(),
  /** browser | renderer | gpu | utility | ... （Electron ProcessMetric.type） */
  type: z.string(),
  name: z.string(),
  cpuPercent: z.number(),
  /** 独占内存（KB）。口径见 main/process-memory.ts */
  memoryKB: z.number(),
  /** 能对应到标签/界面图层时给出人类可读归属（如标签标题），否则为 null */
  owner: z.string().nullable()
})

/**
 * Page 契约 —— 当前页面信息 / 查看源代码。
 * 两者都以「活动标签」为默认目标，也允许显式指定 tabId。
 */
const pageSchemas = Object.freeze({
  info: Object.freeze({
    request: z.object({ tabId: z.string().optional() }).optional(),
    response: z.object({
      tabId: z.string().nullable(),
      url: z.string(),
      title: z.string(),
      favicon: z.string().nullable(),
      isLoading: z.boolean(),
      canGoBack: z.boolean(),
      canGoForward: z.boolean(),
      isPinned: z.boolean(),
      isMuted: z.boolean(),
      isSleeping: z.boolean(),
      osPid: z.number().nullable()
    })
  }),
  viewSource: Object.freeze({
    request: z.object({ tabId: z.string().optional() }).optional(),
    response: z.object({
      url: z.string(),
      /** 主框架的 outerHTML；取不到时为 null（页面已销毁 / 无权限） */
      html: z.string().nullable()
    })
  })
})

const appInfoSchemas = Object.freeze({
  info: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      v8: z.string(),
      platform: z.string(),
      arch: z.string(),
      osVersion: z.string(),
      isPackaged: z.boolean(),
      /**
       * 是否开发态（`app.isPackaged` 与 `process.defaultApp` 一起判定，见
       * app-main/src/main/app/runtime-mode.js）。
       * 渲染层用它决定「关联 / 默认浏览器这类会写系统的能力要不要出现」——
       * 只看 isPackaged 会在某些启动方式下误判成正式包。
       */
      isDevelopment: z.boolean(),
      userDataPath: z.string(),
      defaultUserAgent: z.string()
    })
  })
})

const appSchemas = Object.freeze({
  metrics: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ metrics: z.array(appMetricItem) })
  }),
  killProcess: Object.freeze({
    request: z.object({ pid: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional()
    })
  }),
  info: appInfoSchemas.info,
  // 默认浏览器（Windows）：查询 / 设为系统默认。
  // 「是不是系统默认浏览器」只有主进程问得了 Electron（app.isDefaultProtocolClient），
  // 渲染层无从得知；因此这里只回答一个裸布尔 —— 不是状态对象，也不做任何推断。
  isDefaultBrowser: Object.freeze({
    request: z.unknown().optional(),
    response: z.boolean()
  }),
  setDefaultBrowser: Object.freeze({
    request: z.unknown().optional(),
    // 返回的是**设置后回读的真实状态**（Windows 上登记不等于生效），而非「操作已发出」。
    response: z.boolean()
  }),
  // 配置档案导出 / 导入（G1 / G2）。
  // 与「设为默认浏览器」不同，这两条**必须回话**：导出去了哪、导进来成了哪个档案、
  // 或者为什么失败（文件过大 / 包损坏 / 用户取消）—— 所以是非空结果对象而不是裸布尔。
  exportProfile: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      /** 成功/失败给用户看的一句话（设置页 action.resultHint 渲染它） */
      message: z.string().optional(),
      error: z.string().optional(),
      path: z.string().optional()
    })
  }),
  importProfile: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      message: z.string().optional(),
      error: z.string().optional(),
      /** 导入成功后新建的档案 id（调用方可用它去切换/高亮） */
      profileId: z.string().optional()
    })
  }),
  // 分享 / 二维码（N15）：文本 → QR 的 SVG markup（生成在主进程，页面只内联它）。
  // 生成失败 / 文本为空时回空串（页面据此提示"无法生成"），不抛。
  qr: Object.freeze({
    request: z.object({ text: z.string().max(8192) }),
    response: z.object({ svg: z.string().max(512 * 1024) })
  }),
  // 支付卡 / 地址保管库（N7）。⚠ 注意两条接口的**信息量刻意不同**：
  //   list   只回摘要（掩码 / 前几段）—— 列表接口永远拿不到明文；
  //   reveal 是**显式揭示**单条（用户点了"显示 / 复制"才调），明文只此一个出口。
  formFillList: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      items: z.array(z.object({
        id: z.string().max(256),
        kind: z.enum(['card', 'address']),
        label: z.string().max(256),
        updatedAt: z.number(),
        detail: z.string().max(512)
      })).max(1000)
    })
  }),
  formFillAdd: Object.freeze({
    request: z.object({
      kind: z.enum(['card', 'address']),
      label: z.string().max(256).optional(),
      data: z.record(z.string().max(128), z.string().max(2048))
    }),
    response: z.object({ ok: z.boolean(), id: z.string().optional(), reason: z.string().optional() })
  }),
  formFillRemove: Object.freeze({
    request: z.object({ id: z.string().max(256) }),
    response: z.object({ ok: z.boolean() })
  }),
  formFillReveal: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({
      ok: z.boolean(),
      kind: z.enum(['card', 'address']).optional(),
      data: z.record(z.string().max(128), z.string().max(2048)).optional(),
      reason: z.string().optional()
    })
  }),
  // 填充候选（页面侧要值才能填）：按类型收窄 + 由 `privacy.form_autofill` 把关。
  formFillOptions: Object.freeze({
    request: z.object({ kind: z.enum(['card', 'address']) }),
    response: z.object({
      items: z.array(z.object({
        id: z.string().max(256),
        label: z.string().max(256),
        detail: z.string().max(512),
        data: z.record(z.string().max(128), z.string().max(2048))
      })).max(100)
    })
  })
})

export { appSchemas, pageSchemas }


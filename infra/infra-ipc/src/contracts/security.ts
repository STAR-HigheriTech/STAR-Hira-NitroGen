import { z } from 'zod'

/**
 * Security 契约 —— 崩溃报告与证书错误。
 *
 * 两者共同点：**渲染进程完全拿不到数据**（崩溃记录在 Electron 的 crashReporter 里，
 * 证书对象只在 `app.on('certificate-error')` 回调里出现一次）。因此这两张表只做
 * 只读透传：主进程采集到什么样，页面就展示什么样，不做任何推断或补齐。
 */

const crashReportItem = z.object({
  /** 崩溃时间（毫秒时间戳）；Electron 给的是 Date */
  date: z.number().nullable(),
  /** 崩溃进程类型（如 browser / renderer / gpu）；拿不到为 null */
  type: z.string().nullable(),
  id: z.string().nullable()
})

const crashSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      /** crashReporter 是否已启用（未启用时 reports 必为空，页面据此如实说明） */
      enabled: z.boolean(),
      reports: z.array(crashReportItem)
    })
  })
})

const certificateErrorItem = z.object({
  url: z.string(),
  /** Chromium 的证书错误码（如 -201 ERR_CERT_DATE_INVALID） */
  error: z.string(),
  at: z.number(),
  subjectName: z.string().nullable(),
  issuerName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  validStart: z.number().nullable(),
  validExpiry: z.number().nullable(),
  fingerprint: z.string().nullable()
})

/**
 * 当前站点证书（`security:site` 的 `certificate` 字段）。
 * 字段全部扁平化：主进程用 Node `X509Certificate` 解析后只透传展示所需的几项，
 * 渲染层不需要（也不应该）接触原始 PEM。
 */
const siteCertificate = z.object({
  subjectName: z.string().nullable(),
  issuerName: z.string().nullable(),
  /** 生效 / 过期时间（毫秒时间戳）；解析不到为 null */
  validStart: z.number().nullable(),
  validExpiry: z.number().nullable(),
  serialNumber: z.string().nullable(),
  fingerprint: z.string().nullable(),
  /** Subject Alternative Name 列表（DNS / IP），用于「证书覆盖了哪些域名」 */
  san: z.array(z.string())
})

const observedSiteCertificate = z.object({
  origin: z.string(),
  observedAt: z.number(),
  secure: z.boolean(),
  protocol: z.string(),
  hostname: z.string().nullable(),
  tabId: z.string().nullable(),
  certificate: siteCertificate.nullable(),
  certificateChain: z.array(siteCertificate),
  error: z.string().nullable()
})

const certificateSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      /** 本会话发生过的证书校验失败 */
      certificates: z.array(certificateErrorItem),
      /** 本会话成功读取过的站点证书，供证书页在非来源标签场景复用 */
      siteCertificates: z.array(observedSiteCertificate)
    })
  }),
  safeContinue: Object.freeze({
    request: z.object({ url: z.string().url() }),
    response: z.object({ ok: z.boolean() })
  }),
  /**
   * `security:site` —— 活动标签的传输安全与证书链。
   *
   * 只读聚合：`secure` / `protocol` 永远给出（非 http(s) 页面 `protocol` 为 `about:` 等，
   * `secure` 为 false）；`certificate` 拿不到时为 null，浮层据此降级为「无证书详情」，
   * 而不是报错 —— 证书查询失败不应该让整个站点信息浮层不可用。
   */
  site: Object.freeze({
    request: z.object({ tabId: z.string().optional() }).optional(),
    response: z.object({
      secure: z.boolean(),
      protocol: z.string(),
      hostname: z.string().nullable(),
      origin: z.string().nullable(),
      /** 本次结果对应的标签 id；渲染层用它丢弃切换标签后迟到的旧结果 */
      tabId: z.string().nullable(),
      certificate: siteCertificate.nullable(),
      /** CDP 返回的完整证书链，叶子证书在前 */
      certificateChain: z.array(siteCertificate),
      /** 查询降级原因（仅用于诊断展示，不阻断 UI） */
      error: z.string().nullable()
    })
  })
})

export { crashSchemas, certificateSchemas }


import { z } from 'zod'

/**
 * TOTP 2FA 验证器 IPC 契约。
 *
 * ── 契约在这里的职责边界 ──────────────────────────────────────────────
 * 只做两件事：**拦住请求形状**、**钉死响应里绝不含密钥**。
 *
 * 后者是这一支与其它域最不同的地方：`secretCipher`（以及任何明文密钥）**永远不会**
 * 出现在任何响应里 —— 唯一的例外是 `exportUri`，它的整个语义就是"把这条亮出来"。
 * 把"响应形状里没有密钥字段"写成契约而不是只写在 domain 注释里，是因为
 * **契约是过 IPC 的那道闸**：domain 哪天不小心多回一个字段，这里会直接把它剥掉。
 */

/** 一条条目的**对外形状**（无密钥字段）。 */
const entrySchema = z.object({
  id: z.string(),
  issuer: z.string(),
  account: z.string(),
  algorithm: z.string(),
  digits: z.number(),
  period: z.number(),
  type: z.string(),
  counter: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

/** `add` / `update` 共用的可写字段。`secret` 是**明文 base32**，只在写入方向出现。 */
const writableFields = {
  issuer: z.string().optional(),
  account: z.string().optional(),
  secret: z.string().optional(),
  algorithm: z.string().optional(),
  digits: z.number().optional(),
  period: z.number().optional(),
  type: z.string().optional(),
  counter: z.number().optional()
}

/**
 * 变更方法的统一应答。
 *
 * `ok:false` + `reason` 是**正常路径**而不是异常：加密不可用 / 密钥不是合法 Base32 /
 * 条目不存在 —— 这些都是用户要看到具体原因的业务结果，不该变成一个 rejected invoke
 * 让渲染层去 try/catch 里猜。
 */
const mutationResponse = z.object({ ok: z.boolean(), reason: z.string().optional(), entry: entrySchema.nullish() })

/**
 * 时间校准（本机时钟相对网络时间的偏移）。
 *
 * `offsetMs = 网络时间 - 本机时间`：正数 = 本机偏慢（码会比服务器晚出），
 * 负数 = 本机偏快（码会提前失效）。主进程算码时用的是 `本机 + offsetMs`，
 * 所以这个值**只影响算码**，不改系统时间、不碰其它域。
 *
 * 它随 `code` 一起下发：渲染层的倒计时以同一个基准推进，才不会出现
 * "码已经换了、进度条还剩 3 秒"。`source` 是本次测量采用的网络时间源
 * （纯诊断用，缺省 null = 还没有校准过，偏移为 0）。
 */
const clockSchema = z.object({
  offsetMs: z.number(),
  measuredAt: z.number(),
  source: z.string().nullable()
})

const totpSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(entrySchema)
  }),

  /**
   * 求验证码。
   *
   * 响应里的 `now` 是**主进程的毫秒时间**：渲染层用它算倒计时，而不是各自的
   * `Date.now()` —— 两边时钟差几秒会让进度环跳一下。
   *
   * `remaining` / `period` 可空：**HOTP 没有时间窗**（计数器式），那里是 `null`
   * 而不是 0 —— 0 会被读成"马上就要换"，而真相是"它不会自己变"。
   * `unavailable` = 本机解不开密钥的条目 id（换机器 / 数据损坏），必须报出来。
   */
  code: Object.freeze({
    request: z.object({ id: z.string().optional() }).optional(),
    response: z.object({
      codes: z.array(z.object({
        id: z.string(),
        code: z.string(),
        type: z.string(),
        remaining: z.number().nullable(),
        period: z.number().nullable()
      })),
      now: z.number(),
      unavailable: z.array(z.string()),
      /** 当前生效的时钟偏移（未校准过 = 偏移 0、source null） */
      clock: clockSchema
    })
  }),

  /**
   * 联网校准本机时钟偏差（面板上的「校准」按钮）。
   *
   * 两种语义共用一条路由：
   *   · 正常调用 → 测量网络时间、保存偏移；
   *   · `{ reset: true }` → 清掉已保存的偏移，回到纯本机时间。
   *
   * `ok:false` + `reason` 仍是正常路径（断网 / 时间源都不可用），
   * 面板据此直接显示原因，不需要 try/catch 猜。
   */
  calibrate: Object.freeze({
    request: z.object({ reset: z.boolean().optional() }).optional(),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      reset: z.boolean().optional(),
      offsetMs: z.number().nullable().optional(),
      measuredAt: z.number().nullable().optional(),
      source: z.string().nullable().optional(),
      rttMs: z.number().nullable().optional()
    })
  }),

  add: Object.freeze({
    request: z.object(writableFields).optional(),
    response: mutationResponse
  }),

  /** `id` 必填；其余字段传了才改（未传的沿用原值）。 */
  update: Object.freeze({
    request: z.object({ id: z.string().min(1), ...writableFields }),
    response: mutationResponse
  }),

  remove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  }),

  /**
   * 批量导入。只收 URI（各家导出格式→URI 的转换在渲染层，见 ipc-channels 的说明）。
   *
   * 应答是**尽力而为**的结果：逐条回报"第几条、为什么跳过"，而不是整体成功/失败 ——
   * 导 40 条挂了 1 条就整批回滚，用户只能一条条试，那是最糟的体验。
   */
  import: Object.freeze({
    request: z.object({ uris: z.array(z.string()) }),
    response: z.object({
      ok: z.boolean(),
      added: z.array(entrySchema),
      skipped: z.array(z.object({ index: z.number(), reason: z.string() }))
    })
  }),

  /**
   * 导出为 `otpauth://` URI —— **唯一会把密钥交给渲染层的路由**。
   * 单独成一条（而不是并进 list/export）就是为了让它可审计、可被单独收紧。
   */
  exportUri: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional(), uri: z.string().optional() })
  })
})

export { totpSchemas }


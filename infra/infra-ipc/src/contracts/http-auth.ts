import { z } from 'zod'

/**
 * HTTP Basic 认证契约（对齐 RT `app/basic-auth.ts`）。
 *
 * 三条消息都以 requestId 为凭据：主进程可能同时挂着多个认证请求，
 * 窗口必须证明自己响应的是「哪一次」，否则并发登录会互相串号
 * （典型症状：在 A 站输入的账号被送给了 B 站）。
 */
const httpAuthSchemas = Object.freeze({
  // ready 兼作握手：窗口加载完成时调用，响应直接带回本次请求的展示信息。
  // 这样主进程不需要「先猜窗口什么时候加载好再推 init」，少一次时序赌注。
  ready: Object.freeze({
    request: z.unknown().optional(),
    response: z
      .object({
        requestId: z.string(),
        host: z.string(),
        realm: z.string(),
        schemeLabel: z.string(),
        isProxy: z.boolean()
      })
      .nullable()
  }),
  submit: Object.freeze({
    request: z.object({
      requestId: z.string().min(1),
      username: z.string(),
      password: z.string()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  cancel: Object.freeze({
    request: z.object({ requestId: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  })
})

export { httpAuthSchemas }


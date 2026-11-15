import { z } from 'zod'

const passwordCredentialSchema = z.object({
  hostname: z.string().max(253),
  username: z.string().max(512),
  password: z.string().max(8192),
  profileId: z.string().max(128).optional()
})

const passwordsSchemas = Object.freeze({
  backends: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  setActive: Object.freeze({ request: z.object({ name: z.string().max(128) }), response: z.object({ ok: z.boolean() }) }),
  /**
   * 外部密码后端运行时动作（Bitwarden / 1Password）。
   *
   * `probe`  — 重新探测 CLI 是否存在（用户刚装好 CLI 后点「重新检测」）；
   * `unlock` — 主密码解锁，域内换出会话密钥（只留在主进程内存）；
   * `sign-in`— 登录（bw 用 API Key；1Password 用 email/password/secretKey/address）；
   * `sync`   — 强制与密码库同步（1Password 不支持，后端会如实回 unsupported）。
   *
   * 失败时 `reason` 是可编程 code（`bitwarden-not-logged-in` / `onepassword-bad-password` …），
   * UI 据此决定展示登录表单还是仅提示；`message` 是可读原因。
   */
  backendAction: Object.freeze({
    request: z.object({
      name: z.string().max(128),
      action: z.enum(['probe', 'unlock', 'sign-in', 'sync']),
      password: z.string().max(8192).optional(),
      clientId: z.string().max(4096).optional(),
      clientSecret: z.string().max(4096).optional(),
      email: z.string().max(512).optional(),
      secretKey: z.string().max(4096).optional(),
      address: z.string().max(2048).optional()
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      message: z.string().optional()
    })
  }),
  /**
   * 安装外部 CLI：由主进程弹系统文件选择框，把用户选中的二进制复制到
   * `userData/tools/<toolFileName>`（POSIX 补 chmod 755），随后自动 probe。
   * 这是「不再让用户自己搬文件」的落地入口。
   */
  installTool: Object.freeze({
    request: z.object({ name: z.string().max(128) }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      message: z.string().optional(),
      path: z.string().optional()
    })
  }),
  /**
   * 自动填充建议。`reason` 决定「后端锁定时要不要弹解锁卡」：
   *   load   — 页面加载即请求（不打扰，不弹卡）
   *   focus  — 输入框聚焦（弹卡，按站点节流）
   *   manual — 用户点钥匙图标（弹卡）
   * 省略时按 manual 处理（老调用方语义不变）。
   */
  getSuggestions: Object.freeze({
    request: z.object({
      hostname: z.string().max(253),
      reason: z.enum(['load', 'focus', 'manual']).optional()
    }),
    response: z.array(z.unknown())
  }),
  save: Object.freeze({
    request: passwordCredentialSchema,
    // `backend` = 实际落库的后端（只读外部管理器激活时会回 'builtin'）
    response: z.object({ ok: z.boolean(), strength: z.number().optional(), backend: z.string().optional() })
  }),
  reveal: Object.freeze({
    request: z.object({ id: z.string().min(1).max(256) }),
    response: z.object({
      ok: z.boolean(),
      credential: z.object({
        id: z.string(),
        domain: z.string(),
        username: z.string(),
        password: z.string(),
        manager: z.string(),
        strength: z.object({ score: z.number(), label: z.string() })
      }).optional()
    })
  }),
  update: Object.freeze({
    request: passwordCredentialSchema.extend({ id: z.string().min(1).max(256) }),
    response: z.object({ ok: z.boolean() })
  }),
  export: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      count: z.number().optional(),
      reason: z.string().optional()
    })
  }),
  delete: Object.freeze({ request: z.object({ id: z.string().max(256) }), response: z.object({ ok: z.boolean() }) }),
  list: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  /**
   * 凭据 CSV 批量导入（F-0598）。
   * `unsupported` = 当前后端没有批量导入能力（第三方管理器占位）——如实上报。
   * `reason` = 存储侧拒绝的具体原因（例如加密 provider 不可用）。
   */
  importCsv: Object.freeze({
    request: z.object({ content: z.string().max(16 * 1024 * 1024), profileId: z.string().max(128).optional() }),
    response: z.object({
      imported: z.number(),
      merged: z.number(),
      skipped: z.number(),
      total: z.number(),
      unsupported: z.boolean().optional(),
      reason: z.string().optional()
    })
  }),
  // 密码体检（N8）：只回**问题种类**，绝不回明文（明文在域内用完即弃）。
  // `unsupported` = 当前后端不支持本地检查（第三方管理器占位）—— 如实上报，不假装查过。
  audit: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      checked: z.number(),
      issues: z.array(z.object({
        id: z.string(),
        domain: z.string(),
        username: z.string(),
        kinds: z.array(z.string())
      })),
      unsupported: z.boolean().optional()
    })
  }),
  neverSaveAdd: Object.freeze({ request: z.object({ hostname: z.string().max(253) }), response: z.object({ ok: z.boolean() }) }),
  neverSaveRemove: Object.freeze({ request: z.object({ hostname: z.string().max(253) }), response: z.object({ ok: z.boolean() }) }),
  neverSaveList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.string()) }),
  autofillMenu: Object.freeze({
    request: z.object({ hostname: z.string().max(253), credentials: z.array(z.unknown()).max(100), x: z.number().optional(), y: z.number().optional() }),
    response: z.object({ ok: z.boolean() })
  }),
  captured: Object.freeze({ request: passwordCredentialSchema, response: z.object({ ok: z.boolean() }) }),
  /**
   * 浮层回传。`kind` 的取值：
   *   menu / menu-cancel           多凭据菜单
   *   save / save-dismiss          保存提示卡（save-dismiss = 用户主动关闭，本次会话不再提示）
   *   save-release                 保存卡被菜单 / 解锁卡顶掉（用户尚未决定，之后仍可再提示）
   *   unlock / sign-in             自动填充前的解锁 / 登录卡（字段随后端契约）
   *   unlock-cancel                用户取消解锁
   */
  overlayCommit: Object.freeze({
    request: z.object({
      kind: z.string().max(64),
      hostname: z.string().max(253).optional(),
      credential: z.unknown().optional(),
      action: z.string().max(64).optional(),
      username: z.string().max(512).optional(),
      password: z.string().max(8192).optional(),
      clientId: z.string().max(4096).optional(),
      clientSecret: z.string().max(4096).optional(),
      email: z.string().max(512).optional(),
      secretKey: z.string().max(4096).optional(),
      address: z.string().max(2048).optional()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  generate: Object.freeze({
    request: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
    response: z.object({ ok: z.boolean() })
  })
})

export { passwordsSchemas }


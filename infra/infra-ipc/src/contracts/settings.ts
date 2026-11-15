import { z } from 'zod'

const settingsSchemas = Object.freeze({
  get: Object.freeze({ request: z.object({ key: z.string() }), response: z.unknown() }),
  set: Object.freeze({ request: z.object({ key: z.string(), value: z.unknown() }), response: z.object({ ok: z.boolean() }) }),
  list: Object.freeze({ request: z.object({ section: z.string().optional() }).optional(), response: z.record(z.string(), z.unknown()) }),
  reset: Object.freeze({ request: z.object({ key: z.string().optional() }).optional(), response: z.object({ ok: z.boolean() }) }),
  schema: Object.freeze({ request: z.unknown().optional(), response: z.unknown() }),
  changedKeys: Object.freeze({ request: z.unknown().optional(), response: z.array(z.string()) }),
  cssVars: Object.freeze({ request: z.unknown().optional(), response: z.record(z.string(), z.unknown()) }),
  // 「按空间」写设置（B2 / J13）：给**指定空间**写一个按空间隔离的键。
  // 与 set 的区别只有一点：set 写"当前空间"，这条写"具名空间"—— 空间编辑器要配别的空间，
  // 那时当前空间不是目标空间。非按空间键 / 空间层未启用 → ok:false（由 domain 判定）。
  setForSpace: Object.freeze({
    request: z.object({
      profileId: z.string().min(1).optional(),
      spaceId: z.string().min(1),
      key: z.string().min(1),
      value: z.unknown()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  chooseDirectory: Object.freeze({ request: z.unknown().optional(), response: z.object({ path: z.string().nullable() }) }),
  // 「record」型设置的随机生成：页面只传生成器 id（schema 里的 record.generate），
  // 具体生成逻辑在主进程注册表里 —— 页面不认识任何业务字段。
  recordGenerate: Object.freeze({
    request: z.object({ generator: z.string().min(1) }),
    response: z.unknown()
  }),
  // 拼写检查：可用词典清单（[码, 展示名]）+ 自定义词典（列出 / 删词）。
  // 语言清单是**二维字符串数组**：设置页的动态选项管线就吃这个形状（与 theme:list 的映射结果同构）。
  spellcheckLanguages: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.tuple([z.string(), z.string()]))
  }),
  spellcheckDictionary: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.object({ word: z.string() }))
  }),
  spellcheckDictionaryRemove: Object.freeze({
    request: z.object({ word: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  })
})

export { settingsSchemas }


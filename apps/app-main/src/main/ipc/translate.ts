import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { LANGUAGES, TRANSLATE_SETTING_KEYS } = require('@hira-ng/shared-types/src/translate.mjs')
const TARGET_LANGUAGES = new Set<string>(LANGUAGES.map((language: { id: string }) => language.id))

interface TranslateServicePort {
  translate(request: { texts: readonly string[]; from?: string; to: string; force?: boolean }): Promise<{
    texts: string[]
    provider: string | null
    providerLabel: string | null
    translatedCount: number
    cachedCount: number
    elapsedMs: number
    error?: { code: string; message: string; failures: Array<{ provider: string; label: string; message: string }> }
  }>
}
interface TranslateSettingsPort { set(key: string, value: unknown): unknown }
interface TranslateIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['translate']
  translateService?: TranslateServicePort | null
  settingsService?: TranslateSettingsPort | null
}

/**
 * IPC · Translate 域（C3 网页翻译）。
 *
 * 一条路由：页面的翻译引擎送一批文本 → 交调度器（插件 / 在线来源故障切换）→ 回等长译文与调度状态。
 * 与其它"页面引擎上报"类路由（E3 正文、D3 手势）一样**不走 provider 能力表**：
 * 这是引擎的一次对话，不是"可被插件顶替的业务查询"。
 */

export function registerTranslateIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, translateService, settingsService }: TranslateIpcContext
): void {
  if (!translateService) return

  typedMain.handle(routes.translateText, {
    requestSchema: schemas.text.request,
    responseSchema: schemas.text.response,
    handler: async (_e, req) => translateService.translate({
      texts: req.texts,
      from: req.from,
      to: req.to,
      force: req.force
    })
  })

  typedMain.handle(routes.translateTarget, {
    requestSchema: schemas.target.request,
    responseSchema: schemas.target.response,
    handler: async (_e, req) => {
      const to = String(req.to)
      if (!TARGET_LANGUAGES.has(to)) throw new Error(`不支持的翻译目标语言：${to}`)
      if (!settingsService) throw new Error('翻译设置服务不可用')
      settingsService.set(TRANSLATE_SETTING_KEYS.targetLanguage, to)
      return { to }
    }
  })
}


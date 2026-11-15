/**
 * 画板窗口 —— 画板（D4）的**独立窗口形态**宿主。
 *
 * 与 `inject-editor.js` 完全同构：这里几乎没有业务代码 ——
 * `ui/ui-easel` 的 `windowDefinition` 是"哑组件 + 端口注入"，所有外部能力
 * （设置读写、打开链接、确认框）都从本文件注入的那个 `ctx` 进来。
 *
 * 分层：本文件在 APPS 层（renderer），可以 import `shared/*` 客户端；
 * 反向的 `ui → apps` 被 CONTRACT-11 禁止 —— 端口注入方向永远是 apps → ui。
 */
import { confirm } from '@hira-ng/ui-common'
import { windowDefinition } from '@hira-ng/ui-panel-easel'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge } from '../../shared/bridge.js'
import { settingsClient } from '../../shared/settings-client.js'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import '@hira-ng/shared-ui-tokens/components.css'

export async function mountEaselWindow({ content }: { content: HTMLElement }): Promise<void> {
  const bridge = getHiraBridge()

  if (typeof windowDefinition.injectStyles === 'function') windowDefinition.injectStyles(document)

  /** 端口契约（与面板 ctx 里画板那一支保持同一形状）。 */
  const ctx = {
    clients: { settings: settingsClient },
    // 链接卡片点"打开"：开一个正式标签（本窗口是画板，不该被导航走）。
    openUrl: (url: string) => bridge.provider.invoke(IPC_ROUTES.tabNew, { url }),
    confirm: (opts: string | NonNullable<Parameters<typeof confirm>[1]>) =>
      confirm(document, typeof opts === 'string' ? { message: opts } : opts)
  }

  const mounted = await windowDefinition.mount(document, ctx)
  if (mounted && typeof mounted.start === 'function') mounted.start()

  // 本窗口自己管布局（画布要铺满、不要外层 padding/滚动）。
  content.textContent = ''
  content.style.padding = '0'
  content.style.overflow = 'hidden'
  content.style.display = 'flex'
  content.appendChild(mounted.element)

  window.addEventListener('pagehide', () => {
    if (mounted && typeof mounted.dispose === 'function') mounted.dispose()
  }, { once: true })
}

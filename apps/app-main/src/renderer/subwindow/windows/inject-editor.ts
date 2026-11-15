/**
 * 注入规则编辑器窗口 —— 网页注入（J10）CSS / JS 编辑的**独立窗口**宿主。
 *
 * 与 `easel-window.js` / `bookmark-editor.js` 完全同构：这里几乎没有业务代码 ——
 * `ui/ui-panel-inject` 的 `windowDefinition` 是"哑组件 + 端口注入"，本文件只负责
 * 把「要编辑哪个站点」与「设置读写端口」注入进去。
 *
 * 载荷从 URL 的 `?payload=` 取（`window:open` 的 payload 由主进程拼进子窗口 URL，
 * 与书签编辑器同一套 —— 见 main.js 的 openSubWindowByType）。
 */
import { windowDefinition } from '@hira-ng/ui-panel-inject'
import { PAGE_INJECT_SETTING_KEYS } from '@hira-ng/shared-types/src/page-inject.mjs'
import { getHiraBridge } from '../../shared/bridge.js'
import { settingsClient } from '../../shared/settings-client.js'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import '@hira-ng/shared-ui-tokens/components.css'

export async function mountInjectEditor({ params, content }: { params: URLSearchParams; content: HTMLElement }): Promise<void> {
  const bridge = getHiraBridge()

  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse((params && params.get('payload')) || '{}') || {}
  } catch (_) {
    payload = {}
  }

  if (typeof windowDefinition.injectStyles === 'function') windowDefinition.injectStyles(document)

  const mounted = await windowDefinition.mount(document, {
    // 要编辑哪个站点：优先窗口载荷，其次面板写下的设置项（面板不走载荷 —— 见 panel/index.js）。
    host: typeof payload.host === 'string' ? payload.host : '',
    hostSettingKey: PAGE_INJECT_SETTING_KEYS.editorHost,
    clients: { settings: settingsClient }
  })

  // 编辑器自己管布局（两个代码区要平分高度并各自滚动）。
  content.textContent = ''
  content.style.padding = '0'
  content.style.overflow = 'hidden'
  content.style.display = 'flex'
  content.appendChild(mounted.element)

  window.addEventListener('pagehide', () => {
    if (mounted && typeof mounted.dispose === 'function') mounted.dispose()
  }, { once: true })
}

/**
 * 顶部选项卡旁边的内部页快捷入口。
 *
 * 是**页面外壳**的一部分（三个分区上都在），所以不属于任何分区 ——
 * 与顶部时间同理（两者都住在顶部那一行里、与选项卡同高齐平）。
 *
 * 打开方式就复用现成的 `openUrl`：内部页走的也是 `nav:go`
 * （`hira` 已被注册为可浏览协议，`TabManager#normalizeUrl` 会原样保留
 * `hira://...`），所以**不需要另开一条 IPC 通道**，也不需要新标签页 ——
 * 全工程打开内部页的惯例都是在**当前标签页**打开（见 app-shell 的 navigateInternal）。
 *
 * 清单（顺序）来自 `shared-types/src/pages.mjs#NEWTAB_QUICK_LINKS`，中文名与地址分别由
 * `pageLabel` / `pageUrl` 给出 —— 这里一个字都不抄，改入口只改那张表。
 */
import { NEWTAB_QUICK_LINKS, pageIconSvg, pageLabel, pageUrl } from 'hira://shared/runtime.js'
import type { LinkIntentEvent } from 'hira://shared/link-intent.mjs'

/**
 * @param {HTMLElement} host
 * @param {(url: string) => void} openUrl
 */
export function mountQuickLinks(
  host: HTMLElement,
  openUrl: (url: string, event?: LinkIntentEvent) => void
): void {
  if (!host) return

  for (const key of NEWTAB_QUICK_LINKS) {
    const label = pageLabel(key)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ntp-quick'
    btn.title = label
    btn.setAttribute('aria-label', label)

    // 与标签条 favicon / 侧栏导航同一套字形（host → 字形名 → 路径数据）。
    const svg = pageIconSvg(document, key, { size: 15 })
    if (svg) btn.appendChild(svg)
    else btn.textContent = label

    // 手势交给 openUrl 统一判定（Ctrl/中键 = 后台新标签），这里不做修饰键判断。
    btn.addEventListener('click', (e) => openUrl(pageUrl(key), e))
    host.appendChild(btn)
  }
}

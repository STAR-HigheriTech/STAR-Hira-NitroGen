/**
 * 分区 · 新闻（整页）
 *
 * 与首页那张「新闻热点」卡片**同一套取数**（共享层 service + providers 原封不动），
 * 只是展示形态换成整页大卡片网格。所以这里没有一行网络/缓存/降级代码 ——
 * 那三件事只属于 `packages/shared-types/src/news/service.mjs`，换个形态不该把它们抄第二遍。
 *
 * 源选择记在 shell store 的偏好里（getPref/setPref），
 * 与首页那张卡片的配置互不影响：同一份内容，两处各自选源。
 */
import { defineSection } from './registry.js'
import { defaultProviderId, listProviders, loadNews, formatHot, relativeTime } from '@hira-ng/shared-types/src/news/index.mjs'
import type { NewsItem, NewsLoadResult } from '@hira-ng/shared-types/src/news/index.mjs'
import { getPref, setPref } from './store.js'
import type { SectionContext } from './types.js'

const SECTION_ID = 'news'
const PREF_SOURCE = 'source'
/** 整页展示条数 —— 缓存里最多 40 条，取不满也不会报错。 */
const COUNT = 30

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** 单条 = 一张大卡片（名次 + 标题 + 来源/热度/时间）。 */
function newsCard(
  item: NewsItem,
  rank: number,
  openUrl: SectionContext['openUrl']
): HTMLAnchorElement {
  const card = el('a', 'ntp-news__item')
  card.href = item.url
  card.rel = 'noopener noreferrer'
  if (rank <= 3) card.dataset.top = '1'
  card.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault()
    openUrl(item.url, e)
  })

  card.appendChild(el('span', 'ntp-news__rank', String(rank)))

  const body = el('span', 'ntp-news__body')
  body.appendChild(el('span', 'ntp-news__title', item.title))

  const bits: string[] = []
  if (item.source) bits.push(item.source)
  const hot = formatHot(item.hot)
  if (hot) bits.push('热度 ' + hot)
  const when = relativeTime(item.time)
  if (when) bits.push(when)
  const meta = bits
  if (meta.length) body.appendChild(el('span', 'ntp-news__meta', meta.join(' · ')))

  card.appendChild(body)
  return card
}

defineSection({
  id: 'news',
  name: '新闻',
  description: '整页新闻热点',
  mount(ctx: SectionContext) {
    const root = el('div', 'ntp-sheet ntp-news')
    ctx.root.appendChild(root)

    // ── 头部：源切换 + 刷新 + 状态 ────────────────────────────────────────
    const head = el('div', 'ntp-news__head')

    const sources = el('div', 'ntp-news__sources')
    sources.setAttribute('role', 'tablist')
    sources.setAttribute('aria-label', '新闻源')
    const sourceButtons = new Map<string, HTMLButtonElement>()

    const btnRefresh = el('button', 'ntp-news__refresh', '刷新')
    btnRefresh.type = 'button'

    head.append(sources, btnRefresh)

    const status = el('p', 'ntp-news__status')
    const list = el('div', 'ntp-news__list')
    root.append(head, status, list)

    // 上次选的源可能已经不存在（源被移除/改名）→ 回落到默认源，不让页面空着
    const all = listProviders()
    const saved = String(getPref(SECTION_ID, PREF_SOURCE, '') || '')
    let source = all.some((p) => p.id === saved) ? saved : defaultProviderId()

    for (const provider of all) {
      const btn = el('button', 'ntp-news__src', provider.name)
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.addEventListener('click', () => {
        if (provider.id === source) return
        source = provider.id
        setPref(SECTION_ID, PREF_SOURCE, source)
        paintSources()
        load(true)
      })
      sources.appendChild(btn)
      sourceButtons.set(provider.id, btn)
    }

    function paintSources() {
      for (const [id, btn] of sourceButtons) {
        const on = id === source
        btn.classList.toggle('is-active', on)
        btn.setAttribute('aria-selected', on ? 'true' : 'false')
      }
      btnRefresh.disabled = !all.length
    }

    /** @type {AbortController|null} */
    let controller: AbortController|null = null

    async function load(force: boolean) {
      if (controller) controller.abort()
      controller = new AbortController()
      const signal = controller.signal

      status.textContent = '加载中…'
      list.dataset.loading = '1'

      let result: NewsLoadResult | null
      try {
        result = await loadNews({ providerId: source, limit: COUNT, force, signal })
      } catch (_) {
        result = null
      }
      // 期间又切了源 / 分区被卸载 → 这次结果作废（缓存在 service 里，丢掉的只是一次渲染）
      if (signal.aborted) return

      list.dataset.loading = '0'
      list.replaceChildren()

      if (!result || !result.items.length) {
        status.textContent = '暂时取不到内容，稍后再试'
        return
      }

      const frag = document.createDocumentFragment()
      result.items.forEach((item, i) => frag.appendChild(newsCard(item, i + 1, ctx.openUrl)))
      list.appendChild(frag)

      const tail = result.stale ? ' · 离线缓存' : ''
      status.textContent = `${result.providerName} · ${result.items.length} 条${tail}`
    }

    const onRefresh = () => load(true)
    btnRefresh.addEventListener('click', onRefresh)

    paintSources()
    load(false)

    return {
      destroy() {
        btnRefresh.removeEventListener('click', onRefresh)
        if (controller) controller.abort()
      }
    }
  }
})

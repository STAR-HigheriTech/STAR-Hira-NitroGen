/**
 * 小组件 · 新闻热点
 *
 * 只负责"把 service 给的数据画出来 + 让用户能换源/换条数/手动刷新"。
 * 取数、缓存、降级、超时全在共享层 `packages/shared-types/src/news/service.mjs` ——
 * 组件里一行网络代码都没有，换一个取数策略不需要动这个文件。
 */
import { defineWidget } from '../registry.js'
import { listProviders, defaultProviderId, getProvider, loadNews, relativeTime, formatHot } from '@hira-ng/shared-types/src/news/index.mjs'
import type { NewsItem } from '@hira-ng/shared-types/src/news/index.mjs'
import type { PixelSize, WidgetContext } from '../types.js'

const REFRESH_OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 10, label: '10 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' }
]

/**
 * 本页内存里最后一次成功的结果（按请求的源分槽）。
 *
 * 为什么要它：板层在"改尺寸 / 改配置"时会整块重挂组件。如果每次都从零开始，
 * 用户拉一下卡片大小就会看到骨架闪一下。这里先把上次的结果原样画出来，
 * 再在后台静默刷新 —— 视觉上完全连贯。
 */
interface NewsMemory {
  providerName: string
  items: NewsItem[]
}

const memoryCache = new Map<string, NewsMemory>()

defineWidget({
  id: 'news',
  name: '新闻热点',
  description: '热榜 / 新闻头条，多源可切',
  unique: false,
  defaultSize: { w: 8, h: 4 },
  minSize: { w: 4, h: 2 },
  maxSize: { w: 16, h: 12 },
  settings: [
    {
      key: 'source',
      label: '内容源',
      type: 'select',
      // 函数默认值：取"当前已注册的第一个源"（与 import 顺序无关，见 registry.js）
      default: () => defaultProviderId(),
      options: () => listProviders().map((p) => ({ value: p.id, label: p.name + (p.kind === 'board' ? '（热榜）' : '') }))
    },
    { key: 'count', label: '显示条数', type: 'range', min: 3, max: 20, step: 1, default: 10 },
    { key: 'showHot', label: '显示热度', type: 'boolean', default: true },
    { key: 'showSource', label: '显示条目来源', type: 'boolean', default: false },
    { key: 'autoRefresh', label: '自动刷新', type: 'select', default: 30, options: REFRESH_OPTIONS }
  ],
  create(ctx: WidgetContext) {
    // 存下来的源可能已经不在注册表里了（源被移除 / 改名过，例如那两个已经关站的聚合源）
    // → 回落到默认源。不这么做的话设置面板里那一项会显示成空，
    // 而且拿一个不存在的 id 去请求是白跑一趟。
    const initialSource = typeof ctx.config.source === 'string' ? ctx.config.source : ''
    const cfg = {
      source: getProvider(initialSource) ? initialSource : defaultProviderId(),
      count: Math.max(3, Math.min(20, Number(ctx.config.count) || 10)),
      showHot: ctx.config.showHot !== false,
      showSource: ctx.config.showSource === true,
      autoRefresh: Number(ctx.config.autoRefresh) || 0
    }

    const root = document.createElement('div')
    root.className = 'wg wg-news'
    // 阈值用**像素**：网格粗细以后改，这里不用跟着重调。
    // 太窄或太矮时收起"来源/热度/时间"那行次要信息（紧凑态）。
    // 默认尺寸是 4 行高（244px）—— 阈值要低于它，否则默认卡一落地就是紧凑态。
    const isCompact = (s: PixelSize) => s.pxW < 420 || s.pxH < 230
    root.dataset.compact = isCompact(ctx.size) ? '1' : '0'
    root.innerHTML = `
      <div class="wg-news__head">
        <span class="wg-news__title"></span>
        <span class="wg-news__status"></span>
        <button type="button" class="wg-news__refresh" title="刷新">刷新</button>
      </div>
      <div class="wg-news__body"></div>`

    const titleEl = root.querySelector<HTMLElement>('.wg-news__title')!
    const statusEl = root.querySelector<HTMLElement>('.wg-news__status')!
    const bodyEl = root.querySelector<HTMLElement>('.wg-news__body')!
    const btnRefresh = root.querySelector<HTMLButtonElement>('.wg-news__refresh')!

    let controller: AbortController | null = null
    let autoTimer = 0
    let disposed = false
    let hasData = false

    function setStatus(text: string, tone = ''): void {
      statusEl.textContent = text || ''
      statusEl.dataset.tone = tone || ''
    }

    /** 先把内存里上次的结果画出来（如果有），避免重挂时闪骨架。 */
    function paintMemory() {
      const mem = memoryCache.get(cfg.source)
      if (!mem || !mem.items.length) return false
      hasData = true
      titleEl.textContent = mem.providerName || '新闻'
      renderList(mem.items.slice(0, cfg.count))
      return true
    }

    function renderSkeleton(rows: number): void {
      bodyEl.replaceChildren()
      const wrap = document.createElement('div')
      wrap.className = 'wg-news__skeleton'
      for (let i = 0; i < Math.min(rows, 8); i++) {
        const line = document.createElement('div')
        line.className = 'wg-news__skeleton-row'
        wrap.appendChild(line)
      }
      bodyEl.appendChild(wrap)
    }

    function renderEmpty(text: string): void {
      bodyEl.replaceChildren()
      const empty = document.createElement('div')
      empty.className = 'wg-news__empty'
      empty.textContent = text
      bodyEl.appendChild(empty)
    }

    function renderList(items: NewsItem[]): void {
      bodyEl.replaceChildren()
      const list = document.createElement('ol')
      list.className = 'wg-news__list'

      items.forEach((item, index) => {
        const li = document.createElement('li')
        li.className = 'wg-news__item'

        const rank = document.createElement('span')
        rank.className = 'wg-news__rank' + (index < 3 ? ' is-top' : '')
        rank.textContent = String(index + 1)

        const link = document.createElement('a')
        link.className = 'wg-news__link'
        link.href = item.url
        link.title = item.title
        link.rel = 'noreferrer noopener'
        // 一律交给页面宿主打开：新标签页自己不该被导航走
        link.addEventListener('click', (e: MouseEvent) => {
          e.preventDefault()
          ctx.openUrl(item.url, e)
        })
        link.textContent = item.title

        li.append(rank, link)

        const meta: string[] = []
        if (cfg.showSource && item.source) meta.push(item.source)
        if (cfg.showHot && item.hot !== undefined) meta.push(formatHot(item.hot) + ' 热度')
        const rel = relativeTime(item.time)
        if (rel) meta.push(rel)
        if (meta.length) {
          const metaEl = document.createElement('span')
          metaEl.className = 'wg-news__meta'
          metaEl.textContent = meta.join(' · ')
          li.appendChild(metaEl)
        }

        list.appendChild(li)
      })
      bodyEl.appendChild(list)
    }

    async function refresh(force: boolean) {
      if (controller) controller.abort()
      controller = new AbortController()
      const seq = controller
      if (!hasData) renderSkeleton(cfg.count)
      setStatus('更新中', 'busy')
      btnRefresh.disabled = true

      try {
        const result = await loadNews({
          providerId: cfg.source,
          limit: cfg.count,
          force,
          signal: seq.signal
        })
        if (disposed || seq !== controller) return
        titleEl.textContent = result.providerName || '新闻'
        if (result.items.length) {
          hasData = true
          memoryCache.set(cfg.source, { providerName: result.providerName, items: result.items })
          renderList(result.items)
          setStatus(result.stale ? '离线缓存' : '', result.stale ? 'warn' : '')
        } else {
          renderEmpty('暂时取不到内容，稍后再试')
          setStatus('', '')
        }
      } catch (_) {
        // service 已经把所有失败都吃掉了，走到这里说明是意料之外的问题 ——
        // 仍然不能让卡片空白：给一句人话 + 保留刷新按钮。
        if (!disposed && seq === controller) {
          if (!hasData) renderEmpty('暂时取不到内容，稍后再试')
          setStatus('', '')
        }
      } finally {
        if (!disposed && seq === controller) btnRefresh.disabled = false
      }
    }

    function scheduleAuto() {
      window.clearTimeout(autoTimer)
      const minutes = Number(cfg.autoRefresh) || 0
      if (minutes <= 0) return
      // 先排一次，tick 里再排下一次 —— 避免固定 setInterval 在页面休眠后连发
      const tick = async () => {
        if (disposed) return
        await refresh(false)
        if (!disposed) autoTimer = window.setTimeout(tick, minutes * 60000)
      }
      autoTimer = window.setTimeout(tick, minutes * 60000)
    }

    btnRefresh.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      refresh(true)
    })

    // 从后台切回来时，若数据已过期就顺手刷新一次（不打断用户正在看的列表）
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !hasData) refresh(false)
    }
    document.addEventListener('visibilitychange', onVisible)

    ctx.root.appendChild(root)
    paintMemory() // 重挂（改尺寸/改配置）时先把上次的结果画出来，不留白
    refresh(false)
    scheduleAuto()

    return {
      // 板层在每次布局后回调（拖拽/改尺寸/换断点都会走到），按当前区域大小切紧凑排版
      resize(size: PixelSize) {
        root.dataset.compact = isCompact(size || ctx.size) ? '1' : '0'
      },
      destroy() {
        disposed = true
        window.clearTimeout(autoTimer)
        document.removeEventListener('visibilitychange', onVisible)
        if (controller) controller.abort()
      }
    }
  }
})

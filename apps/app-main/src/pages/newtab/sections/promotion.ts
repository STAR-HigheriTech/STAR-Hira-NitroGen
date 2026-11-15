/**
 * 分区 · 推广
 *
 * 结构刻意很短：**头图 → 赞助位 → 其余产品 → 页脚**。
 * 推广页只该回答两件事："现在能用什么" 和 "去哪拿"，其余（路线图、品牌理念）
 * 是官网"关于我们"的内容，放进来只会稀释重点。
 *
 * 两件事保证它不越界：
 *   1. **站外链接统一代理**：NTP 是内部页，裸 `<a href>` 会把这一页本身导航走。
 *      所以整个分区只挂一个 click 代理，全部交给 `ctx.openUrl`（在当前标签页打开）。
 *      href 仍然保留 → 中键 / 右键"在新标签页打开"等浏览器原生行为不受影响。
 *   2. **伙伴位明确标出「广告」**：第三方内容与自家产品在视觉上分开，
 *      推广必须让人一眼看出是谁在说话。
 */
import { defineSection } from './registry.js'
import { BRAND, HERO, PRODUCTS, SPONSOR } from './promotion-content.js'
import type { SectionContext } from './types.js'

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

/** 带标题的区块。 */
function block(title?: string) {
  const box = el('section', 'ntp-promo__block')
  if (title) box.appendChild(el('h2', 'ntp-promo__h', title))
  return box
}

/** 站外链接：只负责造标签，点击由分区根节点上的代理统一处理。 */
function link(label: string, url: string, className?: string) {
  const a = el('a', className, label)
  a.href = url
  a.rel = 'noopener noreferrer'
  return a
}

function hero() {
  const box = el('div', 'ntp-promo__hero')
  box.appendChild(el('span', 'ntp-promo__eyebrow', HERO.eyebrow))
  box.appendChild(el('h1', 'ntp-promo__title', HERO.title))
  box.appendChild(el('p', 'ntp-promo__desc', HERO.desc))

  const chips = el('div', 'ntp-promo__chips')
  for (const point of HERO.points) chips.appendChild(el('span', 'ntp-promo__chip', point))
  box.appendChild(chips)

  const cta = el('div', 'ntp-promo__cta')
  cta.appendChild(link(HERO.primary.label, HERO.primary.url, 'ntp-promo__btn ntp-promo__btn--primary'))
  cta.appendChild(link(HERO.secondary.label, HERO.secondary.url, 'ntp-promo__btn'))
  box.appendChild(cta)
  return box
}

/** 伙伴位。第三方广告，自带「广告」标签，并且是这一页的重点之一（见 CSS 里给的存在感）。 */
function sponsor() {
  const box = el('div', 'ntp-promo__ad')

  const head = el('div', 'ntp-promo__ad-head')
  head.appendChild(el('span', 'ntp-promo__ad-label', SPONSOR.label))
  head.appendChild(el('strong', 'ntp-promo__ad-brand', SPONSOR.brand))
  head.appendChild(link('转到官网', SPONSOR.url, 'ntp-promo__btn ntp-promo__btn--primary'))
  box.appendChild(head)

  // 优惠信息是这一块的主钩子，单独一行、给足字号
  box.appendChild(el('p', 'ntp-promo__ad-kicker', SPONSOR.kicker))

  const plans = el('div', 'ntp-promo__plans')
  for (const plan of SPONSOR.plans) {
    const card = link('', SPONSOR.url, 'ntp-promo__plan')
    if (plan.hot) card.dataset.hot = '1'

    const top = el('div', 'ntp-promo__plan-top')
    top.appendChild(el('span', 'ntp-promo__plan-badge', plan.badge))
    top.appendChild(el('span', 'ntp-promo__plan-name', plan.name))
    card.appendChild(top)

    const price = el('div', 'ntp-promo__plan-price')
    price.appendChild(el('strong', null, plan.price))
    price.appendChild(el('span', null, plan.unit))
    card.appendChild(price)

    card.appendChild(el('div', 'ntp-promo__plan-spec', plan.spec))
    plans.appendChild(card)
  }
  box.appendChild(plans)
  return box
}

function products() {
  const box = block('其它工具')
  const grid = el('div', 'ntp-promo__grid')
  for (const product of PRODUCTS) {
    const card = link('', product.url, 'ntp-promo__card')
    card.appendChild(el('span', 'ntp-promo__tag', product.tag))
    card.appendChild(el('h3', 'ntp-promo__card-title', product.name))
    card.appendChild(el('p', 'ntp-promo__card-desc', product.desc))
    grid.appendChild(card)
  }
  box.appendChild(grid)
  return box
}

function footer() {
  const box = el('div', 'ntp-promo__foot')
  const links = el('div', 'ntp-promo__foot-links')
  links.appendChild(link('产品官网', BRAND.site, 'ntp-promo__link'))
  links.appendChild(link('产品文档', BRAND.docs, 'ntp-promo__link'))
  links.appendChild(link('GitHub', BRAND.github, 'ntp-promo__link'))
  box.appendChild(links)
  return box
}

defineSection({
  id: 'promotion',
  name: '推广',
  description: 'Higheri 产品与伙伴内容',
  mount(ctx: SectionContext) {
    const root = el('div', 'ntp-sheet ntp-promo')
    ctx.root.appendChild(root)

    root.addEventListener('click', (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const anchor = target?.closest<HTMLAnchorElement>('a[href]') || null
      if (!anchor) return
      e.preventDefault()
      ctx.openUrl(anchor.href, e)
    })

    // 顺序就是重要程度：头图（主推）→ 赞助位（要显眼）→ 其余产品 → 页脚
    root.append(hero(), sponsor(), products(), footer())
  }
})

/**
 * hira://games · 游戏库
 *
 * 设计（对齐「低耦合 / 模块化 / 插件化 + 极致流畅 + 极致内存」）：
 *  - **数据驱动**：全部游戏来自主进程 game:list（扫描 external/games/<id>/game.json），
 *    本页不认识任何具体游戏；新增游戏 = 丢一个目录 + game.json，无需改这里的代码。
 *  - **一次 IPC**：进页面只发一次 game:list，之后全部本地渲染，无轮询、无定时器。
 *  - **一次监听**：所有交互走 .sections 上的事件委托，不为每张卡各挂监听。
 *  - **一次插入**：DocumentFragment 攒好再进 DOM，只触发一次布局。
 *  - **原生启动**：卡片用 <a target="_blank">，新标签、中键、Ctrl+点击全部走浏览器原生行为。
 *  - 不往 window 挂业务对象（宪法 C05），只用 hira://shared/runtime.js 的具名导出。
 */

import { IPC_ROUTES, rpc, el, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, isRecord, requiredById } from 'hira://shared/page-kit.js'

interface GameVariant {
  name: string
  url: string
  icon?: string
}

interface GameRecord {
  url: string
  name: string
  category?: string
  icon?: string
  description?: string
  tags?: string[]
  variants?: GameVariant[]
  source?: string
  accent?: string
}

interface GameListResponse {
  games?: unknown
}

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

const sections = requiredById<HTMLElement>('sections')

/** 卡片强调色 → 极浅底色（图标块用） */
function softBg (accent: string): string {
  return accent ? accent + '1f' : '#eef2f7'
}

/**
 * @param {object} game game:list 返回的 DTO
 * @returns {HTMLElement}
 */
function renderCard (game: GameRecord): HTMLElement {
  const card = el('article', 'game-card')
  card.dataset.url = game.url
  if (game.accent) card.style.setProperty('--accent-soft', softBg(game.accent))

  // 主区：图标 + 名称 + 描述 + 标签
  const main = el('a', 'game-main')
  main.href = game.url
  main.target = '_blank'
  main.rel = 'noopener'

  const icon = el('span', 'game-icon', game.icon || '🎮')
  icon.setAttribute('aria-hidden', 'true')

  const meta = el('span', 'game-meta')
  meta.appendChild(el('span', 'game-name', game.name))
  if (game.description) meta.appendChild(el('span', 'game-desc', game.description))
  if (game.tags && game.tags.length) {
    const tags = el('span', 'game-tags')
    for (const t of game.tags) tags.appendChild(el('i', undefined, t))
    meta.appendChild(tags)
  }

  main.append(icon, meta)
  card.appendChild(main)

  // 底部操作
  const foot = el('div', 'game-foot')
  const copy = el('button', 'btn', '复制链接')
  copy.type = 'button'
  copy.dataset.copy = game.url
  const play = el('a', 'btn btn-primary', '立即游玩')
  play.href = game.url
  play.target = '_blank'
  play.rel = 'noopener'
  foot.append(copy, play)
  card.appendChild(foot)

  // 同 bundle 内的多个玩法 / 关卡
  if (game.variants && game.variants.length) {
    const box = el('div', 'game-variants')
    for (const v of game.variants) {
      const chip = el('a', 'chip', (v.icon ? v.icon + ' ' : '') + v.name)
      chip.href = v.url
      chip.target = '_blank'
      chip.rel = 'noopener'
      box.appendChild(chip)
    }
    card.appendChild(box)
  }

  if (game.source) card.appendChild(el('div', 'src', '来源：' + game.source))

  return card
}

/**
 * @param {object[]} games
 */
function renderAll (games: readonly GameRecord[]): void {
  sections.textContent = ''

  if (!games.length) {
    sections.appendChild(el('div', 'empty', '还没有安装任何游戏。'))
    return
  }

  // 按 category 分组（主进程已排好序，这里保持顺序即可）
  const groups = new Map<string, GameRecord[]>()
  for (const g of games) {
    const category = g.category || '其他'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category)?.push(g)
  }

  const frag = document.createDocumentFragment()
  for (const [category, list] of groups) {
    const section = el('section', 'section')
    section.appendChild(el('h2', 'section-title', category))
    const grid = el('div', 'grid')
    for (const g of list) grid.appendChild(renderCard(g))
    section.appendChild(grid)
    frag.appendChild(section)
  }
  sections.appendChild(frag)
}

/** 复制到剪贴板，失败时回落到选中提示（不抛错打断页面） */
async function copyText (text: string, btn: HTMLButtonElement): Promise<void> {
  const prev = btn.textContent
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    btn.textContent = '已复制'
  } catch {
    btn.textContent = '复制失败'
  }
  window.setTimeout(() => { btn.textContent = prev }, 1200)
}

// ── 唯一的事件监听：委托到容器 ────────────────────────────────────────────
sections.addEventListener('click', (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const copyBtn = target.closest<HTMLButtonElement>('[data-copy]')
  if (copyBtn) {
    event.preventDefault()
    event.stopPropagation()
    copyText(copyBtn.dataset.copy || '', copyBtn)
    return
  }
  // 点到了链接本身：交给浏览器原生处理（新标签 / 中键 / 修饰键）
  if (target.closest('a')) return

  // 点卡片空白处：等价于点「立即游玩」
  const card = target.closest<HTMLElement>('.game-card')
  if (card && card.dataset.url) window.open(card.dataset.url, '_blank')
})

// ── 启动 ─────────────────────────────────────────────────────────────────
;(async () => {
  try {
    const data = await rpc<GameListResponse>(IPC_ROUTES.gameList, {})
    const games = Array.isArray(data?.games) ? data.games.filter(isRecord) as unknown as GameRecord[] : []
    renderAll(games)
  } catch (err) {
    sections.textContent = ''
    sections.appendChild(el('div', 'empty', '游戏库加载失败：' + errorMessage(err)))
  }
})()

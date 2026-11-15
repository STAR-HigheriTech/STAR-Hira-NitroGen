/**
 * 小组件 · 快速拨号
 *
 * 常用网站的一格一格入口。数据完全由主进程 `ntp:*` 四条路由托管
 * （持久化在设置键 `app.speed_dial`，见 ipc/ntp.js），组件自己不碰 storage。
 *
 * 交互只有三件事：点格子打开、右键管理（重命名 / 删除）、点「+」新增。
 * 右键管理走**原生菜单**（与网页右键 / 面板行右键同一个形状）；只有需要输入框的
 * 新增 / 重命名表单、以及删除确认，才用页面内浮层。
 */
import { defineWidget } from '../registry.js'
import { rpc, faviconBadge, popupMenu } from 'hira://shared/runtime.js'
import { createPopover } from '../popover.js'
import type { PixelSize, WidgetContext } from '../types.js'

interface SpeedDialSite {
  id: string
  title: string
  url: string
}

interface RawSpeedDialSite {
  id: string
  title?: string
  url: string
}

interface MutationResult {
  ok?: boolean
  id?: string
}

const ROUTES = Object.freeze({
  list: 'ntp:list-sites',
  add: 'ntp:add-site',
  remove: 'ntp:remove-site',
  rename: 'ntp:rename-site'
})

/** 本页内存缓存：改尺寸 / 改配置会整块重挂，先用上次结果画满，避免闪空。 */
let memoryCache: SpeedDialSite[] | null = null

/** 没有 scheme 的输入按 https 补全（主进程不做规范化，这里补一次）。 */
function normalizeUrl (raw: unknown): string {
  const v = String(raw || '').trim()
  if (!v) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return v
  return 'https://' + v
}

function hostOf (url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch (_) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  }
}

/** 标题缺省（主进程会把 url 当 title）时，显示成更短的域名。 */
function displayTitle (site: SpeedDialSite): string {
  const t = String(site.title || '').trim()
  if (t && t !== site.url) return t
  return hostOf(site.url) || site.url
}

function isSpeedDialSite(value: unknown): value is RawSpeedDialSite {
  if (!value || typeof value !== 'object') return false
  const site = value as Record<string, unknown>
  return typeof site.id === 'string' && typeof site.url === 'string' &&
    (typeof site.title === 'string' || site.title === undefined)
}

defineWidget({
  id: 'speed-dial',
  name: '快速拨号',
  description: '常用网站，一键直达',
  unique: true,
  defaultSize: { w: 8, h: 4 },
  minSize: { w: 3, h: 2 },
  maxSize: { w: 16, h: 8 },
  settings: [
    { key: 'showTitles', label: '显示站点名称', type: 'boolean', default: true }
  ],
  create(ctx: WidgetContext) {
    const showTitles = ctx.config.showTitles !== false
    const root = document.createElement('div')
    root.className = 'wg wg-speed-dial'
    // 阈值用像素：网格粗细变化时不用跟着重调
    const isCompact = (s: PixelSize) => s.pxW < 360
    root.dataset.compact = isCompact(ctx.size) ? '1' : '0'

    const grid = document.createElement('div')
    grid.className = 'wg-speed-dial__grid'

    const statusEl = document.createElement('div')
    statusEl.className = 'wg-speed-dial__status'
    statusEl.hidden = true

    root.append(grid, statusEl)
    ctx.root.appendChild(root)

    let sites: SpeedDialSite[] = Array.isArray(memoryCache) ? memoryCache.slice() : []
    let disposed = false
    let loading = false
    let pending = false

    // ── 两个浮层（删除确认 / 表单），随组件销毁一起摘掉 ──────────────────
    // 右键菜单本身**不自绘**：走 `popupMenu` 请主进程弹原生 Menu（见 openMenu）。
    const confirm = createPopover({ className: 'wg-speed-dial__menu-pop' })
    const form = createPopover({ className: 'wg-speed-dial__form-pop' })

    form.panel.innerHTML = `
      <form class="wg-speed-dial__form" novalidate>
        <input class="wg-speed-dial__input" name="url" type="text" placeholder="网址，例如 github.com" autocomplete="off" spellcheck="false">
        <input class="wg-speed-dial__input" name="title" type="text" placeholder="名称（可选）" autocomplete="off" spellcheck="false">
        <div class="wg-speed-dial__actions">
          <button type="submit" class="wg-speed-dial__submit">添加</button>
          <button type="button" class="wg-speed-dial__cancel">取消</button>
        </div>
        <p class="wg-speed-dial__hint" hidden></p>
      </form>`

    const formEl = form.panel.querySelector<HTMLFormElement>('form')!
    const urlInput = formEl.querySelector<HTMLInputElement>('[name="url"]')!
    const titleInput = formEl.querySelector<HTMLInputElement>('[name="title"]')!
    const submitBtn = formEl.querySelector<HTMLButtonElement>('.wg-speed-dial__submit')!
    const cancelBtn = formEl.querySelector<HTMLButtonElement>('.wg-speed-dial__cancel')!
    const hintEl = formEl.querySelector<HTMLElement>('.wg-speed-dial__hint')!

    let formMode: 'add' | 'rename' = 'add'
    let formSite: SpeedDialSite | null = null
    let menuAnchor: HTMLElement | null = null

    function showHint (text: string): void {
      hintEl.textContent = text || ''
      hintEl.hidden = !text
      form.reposition()
    }

    // ── 绘制 ────────────────────────────────────────────────────────────
    function createTile (site: SpeedDialSite): HTMLButtonElement {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'wg-speed-dial__tile'
      tile.title = displayTitle(site) + '\n' + site.url
      tile.appendChild(faviconBadge(site.url, displayTitle(site), null, { size: 28 }))
      if (showTitles) {
        const label = document.createElement('span')
        label.className = 'wg-speed-dial__label'
        label.textContent = displayTitle(site)
        tile.appendChild(label)
      }
      // 手势交给 openUrl（Ctrl/中键 = 后台新标签），组件不自己判断修饰键。
      tile.addEventListener('click', (e: MouseEvent) => ctx.openUrl(site.url, e))
      tile.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        openMenu(site, tile, e)
      })
      return tile
    }

    function createAddTile () {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'wg-speed-dial__add'
      tile.title = '添加常用网站'

      const plus = document.createElement('span')
      plus.className = 'wg-speed-dial__plus'
      plus.setAttribute('aria-hidden', 'true')
      plus.textContent = '+'
      tile.appendChild(plus)

      if (showTitles) {
        const label = document.createElement('span')
        label.className = 'wg-speed-dial__label'
        label.textContent = '添加'
        tile.appendChild(label)
      }
      tile.addEventListener('click', () => openAddForm(tile))
      return tile
    }

    function render () {
      grid.replaceChildren()
      for (const site of sites) grid.appendChild(createTile(site))
      if (!sites.length) {
        const empty = document.createElement('div')
        empty.className = 'wg-speed-dial__empty'
        empty.textContent = '还没有常用网站'
        grid.appendChild(empty)
      }
      grid.appendChild(createAddTile())
    }

    // ── 菜单（原生）─────────────────────────────────────────────────────
    function menuButton (
      text: string,
      tone: string,
      onClick: () => void | Promise<void>
    ): HTMLButtonElement {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'wg-speed-dial__menu-item' + (tone ? ' is-' + tone : '')
      btn.textContent = text
      btn.addEventListener('click', onClick)
      return btn
    }

    /**
     * 右键管理：**原生 Menu**（与网页右键、面板行右键同一个形状）。
     * 菜单结果以 action 字符串回传，动作派发留在本组件 —— 与其它右键菜单同一套协议。
     * 只有删除确认 / 表单这类需要正文的地方才用页面内浮层。
     */
    async function openMenu (
      site: SpeedDialSite,
      anchor: HTMLButtonElement,
      e: MouseEvent
    ): Promise<void> {
      form.close()
      confirm.close()
      menuAnchor = anchor
      // 键盘触发（Shift+F10 / 菜单键）时 clientX/Y 都是 0 —— 退化成格子底边中点，
      // 否则菜单会跑到页面左上角。
      const rect = anchor.getBoundingClientRect()
      const hasPointer = !!(e.clientX || e.clientY)
      const action = await popupMenu({
        items: [
          { label: '重命名', action: 'rename' },
          { type: 'separator' },
          { label: '删除', action: 'delete' }
        ],
        x: hasPointer ? e.clientX : rect.left + rect.width / 2,
        y: hasPointer ? e.clientY : rect.bottom
      })
      if (disposed || !action) return
      if (action === 'rename') return openRenameForm(site)
      if (action === 'delete') return renderDeleteConfirm(site)
    }

    function renderDeleteConfirm (site: SpeedDialSite): void {
      confirm.panel.replaceChildren()

      const title = document.createElement('div')
      title.className = 'ntp-pop__title'
      title.textContent = '删除「' + displayTitle(site) + '」？'

      const list = document.createElement('div')
      list.className = 'wg-speed-dial__menu'
      list.append(
        menuButton('删除', 'danger', async () => {
          confirm.close()
          try {
            const res = await rpc<MutationResult>(ROUTES.remove, { id: site.id })
            if (res && res.ok === false) throw new Error('remove failed')
            sites = sites.filter((s) => s.id !== site.id)
            memoryCache = sites.slice()
            statusEl.hidden = true
            render()
          } catch (_) {
            statusEl.textContent = '删除失败，请重试'
            statusEl.hidden = false
          }
        }),
        menuButton('取消', '', () => confirm.close())
      )

      confirm.panel.append(title, list)
      confirm.open(menuAnchor || root)
    }

    // ── 新增 / 重命名表单 ───────────────────────────────────────────────
    function openAddForm (anchor: HTMLElement): void {
      confirm.close()
      formMode = 'add'
      formSite = null
      urlInput.hidden = false
      urlInput.value = ''
      titleInput.value = ''
      submitBtn.textContent = '添加'
      showHint('')
      form.open(anchor)
      requestAnimationFrame(() => urlInput.focus())
    }

    function openRenameForm (site: SpeedDialSite): void {
      formMode = 'rename'
      formSite = site
      menuAnchor = menuAnchor || root
      urlInput.hidden = true
      titleInput.value = site.title || ''
      submitBtn.textContent = '保存'
      showHint('')
      form.open(menuAnchor)
      requestAnimationFrame(() => {
        titleInput.focus()
        titleInput.select()
      })
    }

    formEl.addEventListener('submit', async (e: SubmitEvent) => {
      e.preventDefault()
      if (pending) return

      if (formMode === 'rename') {
        const title = titleInput.value.trim()
        if (!title) return showHint('名称不能为空')
        pending = true
        try {
          if (!formSite) return
          const res = await rpc<MutationResult>(ROUTES.rename, { id: formSite.id, title })
          if (!res || res.ok === false) throw new Error('rename failed')
          sites = sites.map((s) => (s.id === formSite?.id ? { ...s, title } : s))
          memoryCache = sites.slice()
          statusEl.hidden = true
          render()
          form.close()
        } catch (_) {
          showHint('改名失败，请重试')
        } finally {
          pending = false
        }
        return
      }

      const url = normalizeUrl(urlInput.value)
      if (!url) return showHint('请输入网址')
      const title = titleInput.value.trim()
      pending = true
      try {
        const res = await rpc<MutationResult>(ROUTES.add, { url, title })
        if (!res || res.ok === false || !res.id) throw new Error('add failed')
        sites = sites.concat([{ id: res.id, title, url }])
        memoryCache = sites.slice()
        statusEl.hidden = true
        render()
        form.close()
      } catch (_) {
        showHint('添加失败，请重试')
      } finally {
        pending = false
      }
    })

    cancelBtn.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      form.close()
    })

    // ── 首次拉取 ────────────────────────────────────────────────────────
    async function refresh () {
      if (loading || disposed) return
      loading = true
      try {
        const list = await rpc<unknown>(ROUTES.list, {})
        if (disposed || !Array.isArray(list)) return
        sites = list.filter(isSpeedDialSite).map((site) => ({
          id: site.id,
          url: site.url,
          title: site.title || ''
        }))
        memoryCache = sites.slice()
        statusEl.hidden = true
        render()
      } catch (_) {
        if (disposed) return
        if (!sites.length) {
          statusEl.textContent = '常用网站加载失败'
          statusEl.hidden = false
        }
      } finally {
        loading = false
      }
    }

    render()
    refresh()

    return {
      resize (size: PixelSize) {
        root.dataset.compact = isCompact(size) ? '1' : '0'
      },
      destroy () {
        disposed = true
        confirm.close()
        confirm.panel.remove()
        form.close()
        form.panel.remove()
      }
    }
  }
})

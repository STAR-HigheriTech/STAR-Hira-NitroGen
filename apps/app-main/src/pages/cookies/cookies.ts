import { IPC_ROUTES, rpc, el, fmtTime, renderEmpty, initTheme } from 'hira://shared/runtime.js'
import { createDisclosure } from 'hira://shared/disclosure.js'
import { errorMessage, isRecord, requiredById } from 'hira://shared/page-kit.js'

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

interface CookieRecord {
  domain?: string
  path?: string
  secure?: boolean
  session?: boolean
  expirationDate?: number
  name?: string
  value?: string
}

interface CookieListResponse {
  cookies?: unknown
}

interface OperationResponse {
  ok?: unknown
}

const list = requiredById<HTMLElement>('list')
const summary = requiredById<HTMLElement>('summary')
const filterInput = requiredById<HTMLInputElement>('filter')
const refreshButton = requiredById<HTMLButtonElement>('refresh')
const clearButton = requiredById<HTMLButtonElement>('clear')

let cookies: CookieRecord[] = []
let filterText = ''
/** 手动展开过的站点（原始 domain 为准）。刷新重绘时恢复，避免「刚点开就被重排收起」 */
const openSites = new Set<string>()

/**
 * 用 Cookie 的 domain / path / secure 拼出 `session.cookies.remove(url, name)` 需要的 URL。
 * 拼不出合法 URL 时返回 null —— 调用方必须禁用删除按钮并说明原因，不得静默失败。
 */
function cookieUrl (cookie: CookieRecord): string | null {
  const host = String(cookie.domain || '').replace(/^\./, '')
  const path = String(cookie.path || '')
  if (!host) return null
  if (!path.startsWith('/')) return null
  return (cookie.secure ? 'https://' : 'http://') + host + path
}

function expiryText (cookie: CookieRecord): string {
  if (cookie.session) return '会话结束时'
  if (typeof cookie.expirationDate === 'number') return fmtTime(cookie.expirationDate * 1000)
  return '未知'
}

/* 站点名去掉前导点，只影响显示；分组键仍用原始 domain，避免把 .a.com 与 a.com 合并 */
function displayHost (domain: unknown): string {
  return String(domain || '').replace(/^\./, '') || '（未知域名）'
}

/** 按域名分组：组内先按路径、再按名称排序，保证同一站的 Cookie 聚在一起且顺序稳定 */
function groupByDomain (items: readonly CookieRecord[]): Array<[string, CookieRecord[]]> {
  const groups = new Map<string, CookieRecord[]>()
  for (const cookie of items) {
    const domain = String(cookie.domain || '')
    let bucket = groups.get(domain)
    if (!bucket) groups.set(domain, (bucket = []))
    bucket.push(cookie)
  }
  return [...groups.entries()]
    .sort((a, b) => displayHost(a[0]).localeCompare(displayHost(b[0])))
    .map(([domain, bucket]) => [
      domain,
      bucket.sort((a: CookieRecord, b: CookieRecord) => {
        const byPath = String(a.path || '').localeCompare(String(b.path || ''))
        return byPath !== 0 ? byPath : String(a.name || '').localeCompare(String(b.name || ''))
      })
    ])
}

/**
 * 单条 Cookie：名称 + （路径 · 过期）双行信息 → 值 → 删除。
 * 域名已在组头，行内不再重复；路径/过期降级为次要信息，避免五列横排的噪音。
 */
function buildRow (cookie: CookieRecord): HTMLElement {
  const url = cookieUrl(cookie)
  const row = el('div', 'ck-row' + (url ? '' : ' blocked'))

  const info = el('div', 'ck-info')
  info.appendChild(el('span', 'ck-name', cookie.name || '（未命名）'))

  const meta = el('span', 'ck-meta')
  meta.appendChild(el('span', undefined, String(cookie.path || '/')))
  meta.appendChild(el('span', 'ck-sep', '·'))
  meta.appendChild(el('span', undefined, expiryText(cookie)))
  if (!url) {
    meta.appendChild(el('span', 'ck-sep', '·'))
    const flag = el('span', 'ck-flag', '不可删除')
    flag.title = '该 Cookie 的域名或路径不完整，拼不出删除 URL。可改用「清空全部」。'
    meta.appendChild(flag)
  }
  info.appendChild(meta)
  row.appendChild(info)

  const valueText = String(cookie.value ?? '')
  const value = el('span', 'ck-value', valueText === '' ? '（空值）' : valueText)
  value.title = valueText
  row.appendChild(value)

  const actions = el('div', 'ck-actions')
  const remove = el('button', 'icon-btn', '\u2715')
  if (url) {
    remove.title = '删除该 Cookie'
    remove.onclick = async () => {
      try {
        const res = await rpc<OperationResponse>(IPC_ROUTES.cookieRemove, { url, name: cookie.name || '' })
        if (!res || res.ok !== true) {
          summary.textContent = '删除失败：主进程未确认成功。'
          return
        }
      } catch (error) {
        summary.textContent = '删除失败：' + errorMessage(error)
        return
      }
      await refresh()
    }
  } else {
    remove.disabled = true
    remove.title = '无法删除：缺少可用的域名或路径'
  }
  actions.appendChild(remove)
  row.appendChild(actions)

  return row
}

function buildGroup (
  domain: string,
  bucket: readonly CookieRecord[],
  open: boolean
): HTMLElement {
  const group = createDisclosure({
    title: displayHost(domain),
    count: bucket.length,
    open,
    onToggle (next = false) {
      if (next) openSites.add(domain)
      else openSites.delete(domain)
    }
  })
  group.head.title = domain
  for (const cookie of bucket) group.body.appendChild(buildRow(cookie))
  return group.root
}

function render (): void {
  const query = filterText.toLowerCase()
  // 搜索只认域名：用户找的是「哪个站点」，不是某条 cookie 的名字。
  // 命中站点后仍然保持组收起 —— 组内明细要不要看，由用户自己点开（不强制展开）。
  const visible = query
    ? cookies.filter((cookie: CookieRecord) => String(cookie.domain || '').toLowerCase().includes(query))
    : cookies

  const siteCount = new Set(visible.map((cookie: CookieRecord) => String(cookie.domain || ''))).size
  summary.textContent = query
    ? `显示 ${visible.length} / 共 ${cookies.length} 条 · ${siteCount} 个站点`
    : `共 ${cookies.length} 条 · ${siteCount} 个站点`

  list.textContent = ''
  if (visible.length === 0) {
    renderEmpty(list, cookies.length ? '没有匹配的 Cookie。' : '当前配置文件下没有任何 Cookie。')
    return
  }

  const fragment = document.createDocumentFragment()
  for (const [domain, bucket] of groupByDomain(visible)) {
    fragment.appendChild(buildGroup(domain, bucket, openSites.has(domain)))
  }
  list.appendChild(fragment)
}

async function refresh (): Promise<void> {
  try {
    const res = await rpc<CookieListResponse>(IPC_ROUTES.cookieList, {})
    cookies = Array.isArray(res?.cookies) ? res.cookies.filter(isRecord) as CookieRecord[] : []
  } catch (error) {
    cookies = []
    list.textContent = ''
    summary.textContent = ''
    renderEmpty(list, '读取 Cookie 失败：' + errorMessage(error))
    return
  }
  // 站点已不存在的手动展开记录顺手清掉，避免集合无限增长
  const live = new Set(cookies.map((cookie: CookieRecord) => String(cookie.domain || '')))
  for (const domain of openSites) if (!live.has(domain)) openSites.delete(domain)
  render()
}

refreshButton.onclick = refresh

clearButton.onclick = async () => {
  if (!confirm('确定要清空当前配置文件的全部 Cookie 吗？此操作不可撤销。')) return
  try {
    const res = await rpc<OperationResponse>(IPC_ROUTES.cookieClear, {})
    if (!res || res.ok !== true) {
      summary.textContent = '清空失败：主进程未确认成功。'
      return
    }
  } catch (error) {
    summary.textContent = '清空失败：' + errorMessage(error)
    return
  }
  openSites.clear()
  await refresh()
}

filterInput.addEventListener('input', (event: Event) => {
  const target = event.currentTarget
  filterText = target instanceof HTMLInputElement ? target.value.trim() : ''
  render()
})

refresh()

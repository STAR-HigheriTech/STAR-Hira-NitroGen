import { IPC_ROUTES, initTheme, rpc } from 'hira://shared/runtime.js'
import { pageUrl } from 'hira://shared/pages.mjs'

/**
 * 错误页同样是内部页 —— 主题只有 initTheme() 这一个入口。
 *
 * 为什么必须显式接：它有两种出现方式（标签导航失败 / NETWORK_ERROR 子窗口），
 * 两种都是**我们自己的 hira:// 页面**，不是站点；站点不定义背景时由视图白纸兜底，
 * 而这里我们自己画整页，不接主题就会永远是出厂浅色（深色主题下白得刺眼）。
 *
 * initTheme 会写 `html[data-theme]` 并把主进程算好的令牌表灌到 html + body 的内联变量上，
 * 下面的 CSS 只消费 token，不在本页自己判断深浅（那会造出第二处会漂移的真源）。
 */
initTheme()

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Error page element #${id} is unavailable`)
  return element as unknown as T
}

const params = new URLSearchParams(window.location.search)
const errorCode = params.get('errorCode') || '-105'
const url = params.get('url') || ''
const webSidebarSurface = params.get('surface') === 'web-sidebar'
const displayUrl = (() => { try { return new URL(url).hostname || url } catch { return url } })()
const reloadUrl = (() => {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''
  } catch {
    return ''
  }
})()
const safeDisplayUrl = displayUrl
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

interface ErrorInfo {
  title: string
  desc: string
  code: string
}

const INFO: Readonly<Record<string, ErrorInfo>> = {
  '-6': { title: '找不到您的文件', desc: '该文件可能已被移动或删除。', code: 'ERR_FILE_NOT_FOUND' },
  '-10': { title: '无法访问此网站', desc: '网页 <b>' + safeDisplayUrl + '</b> 可能暂时无法访问，或者已永久移动到新的网址。', code: 'ERR_ACCESS_DENIED' },
  '-102': { title: '无法访问此网站', desc: '服务器拒绝了连接请求。', code: 'ERR_CONNECTION_REFUSED' },
  '-105': { title: '无法访问此网站', desc: '无法找到 <b>' + safeDisplayUrl + '</b> 的服务器 IP 地址。', code: 'ERR_NAME_NOT_RESOLVED' },
  '-106': { title: '未连接到互联网', desc: '请尝试：<ul><li>检查网络电缆、调制解调器和路由器</li><li>重新连接到 Wi-Fi</li></ul>', code: 'ERR_INTERNET_DISCONNECTED' },
  '-108': { title: '无法访问此网站', desc: '网页 <b>' + safeDisplayUrl + '</b> 可能暂时无法访问，或者已永久移动到新的网址。', code: 'ERR_ADDRESS_INVALID' },
  '-109': { title: '无法访问此网站', desc: '<b>' + safeDisplayUrl + '</b> 无法访问。', code: 'ERR_ADDRESS_UNREACHABLE' },
  '-118': { title: '连接超时', desc: '连接 <b>' + safeDisplayUrl + '</b> 超时，请稍后重试。', code: 'ERR_CONNECTION_TIMED_OUT' },
  '-137': { title: '名称解析失败', desc: '无法解析 <b>' + safeDisplayUrl + '</b> 的主机名。', code: 'ERR_NAME_RESOLUTION_FAILED' },
  '-200': { title: '证书错误', desc: '此网站的安全证书有问题，无法安全连接。', code: 'ERR_CERT_AUTHORITY_INVALID' },
  '-300': { title: '无法访问此网站', desc: '网页 <b>' + safeDisplayUrl + '</b> 可能暂时无法访问，或者已永久移动到新的网址。', code: 'ERR_INVALID_URL' },
  '-324': { title: '连接已重置', desc: '与 <b>' + safeDisplayUrl + '</b> 的连接被重置。', code: 'ERR_EMPTY_RESPONSE' },
  '-379': { title: '无法访问此网站', desc: '网页 <b>' + safeDisplayUrl + '</b> 可能暂时无法访问，或者已永久移动到新的网址。', code: 'ERR_HTTP_RESPONSE_CODE_FAILURE' },
  '-501': { title: '无法访问此网站', desc: '遇到了网络错误，无法加载 <b>' + safeDisplayUrl + '</b>。', code: 'ERR_INSECURE_RESPONSE' }
}

const info = INFO[errorCode] || INFO['-105']
requiredElement<HTMLElement>('title').textContent = info.title
requiredElement<HTMLElement>('desc').innerHTML = info.desc
requiredElement<HTMLElement>('code').textContent = info.code + ' (' + errorCode + ')'
document.title = info.title

const backButton = requiredElement<HTMLButtonElement>('back')
const reloadButton = requiredElement<HTMLButtonElement>('reload')

async function runNavigationAction(
  button: HTMLButtonElement,
  route: string,
  fallback: () => void
): Promise<void> {
  if (button.disabled) return
  button.disabled = true
  try {
    const result = await rpc<{ ok?: boolean }>(route, {})
    if (result?.ok !== false) return
    fallback()
  } catch {
    fallback()
  } finally {
    button.disabled = false
  }
}

if (webSidebarSurface) {
  // 侧栏有自己的导航状态，页面内的 history / location 才是正确目标。
  backButton.classList.toggle('hidden', window.history.length <= 1)
  backButton.onclick = () => window.history.back()
  reloadButton.onclick = () => {
    if (reloadUrl) window.location.assign(reloadUrl)
  }
} else {
  // 标签页里的错误页只是过渡视图：返回与重试都必须走宿主导航，
  // 页面自己的 history / location 看不到失败导航与完整标签历史。
  backButton.onclick = () => {
    void runNavigationAction(backButton, IPC_ROUTES.navBack, () => window.history.back())
  }
  reloadButton.onclick = () => {
    void runNavigationAction(reloadButton, IPC_ROUTES.navReload, () => {
      if (reloadUrl) window.location.assign(reloadUrl)
    })
  }

  // 返回按钮只在标签确实有后退历史时出现。window.history 与标签导航历史不是同一份状态，
  // 因此先同步隐藏，再向宿主确认；确认可后退时恢复显示。
  backButton.classList.add('hidden')
  void rpc<{ canGoBack?: boolean }>(IPC_ROUTES.navEntries, {})
    .then((state) => {
      backButton.classList.toggle('hidden', state?.canGoBack !== true)
    })
    .catch(() => {
      backButton.classList.toggle('hidden', window.history.length <= 1)
    })
}

// 游戏库（地址来自 pages.mjs，与侧栏 / 菜单同一条拼法）
requiredElement<HTMLButtonElement>('games').onclick = () => {
  window.location.href = pageUrl('games')
}

// 首次加载时移除 initial 参数，避免刷新循环
const initial = params.get('initial')
if (initial) {
  const newURL = new URL(window.location.href)
  newURL.searchParams.delete('initial')
  window.history.replaceState({}, '', newURL.toString())
}

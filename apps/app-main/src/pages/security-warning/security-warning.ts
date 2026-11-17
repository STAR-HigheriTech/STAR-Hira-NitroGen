import { IPC_ROUTES, initTheme, rpc } from 'hira://shared/runtime.js'

initTheme()

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Security warning element #${id} is unavailable`)
  return element as unknown as T
}

const params = new URLSearchParams(window.location.search)
const targetUrl = params.get('url') || ''
const reason = params.get('reason') || '此页面被本地安全检查标记。'
const dangerous = params.get('level') === 'dangerous'
const displayTarget = (() => {
  try {
    const url = new URL(targetUrl)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return targetUrl
  }
})()

const title = dangerous ? '已阻止高风险页面' : '此页面可能存在风险'
requiredElement<HTMLElement>('title').textContent = title
requiredElement<HTMLElement>('reason').textContent = reason
requiredElement<HTMLElement>('url').textContent = displayTarget || targetUrl
document.title = title

const backButton = requiredElement<HTMLButtonElement>('back')
const reloadButton = requiredElement<HTMLButtonElement>('reload')
reloadButton.disabled = !targetUrl

backButton.classList.add('hidden')
void rpc<{ canGoBack?: boolean }>(IPC_ROUTES.navEntries, {})
  .then((state) => {
    backButton.classList.toggle('hidden', state?.canGoBack !== true)
  })
  .catch(() => {
    backButton.classList.toggle('hidden', window.history.length <= 1)
  })

backButton.addEventListener('click', async () => {
  if (backButton.disabled) return
  backButton.disabled = true
  try {
    const result = await rpc<{ ok?: boolean }>(IPC_ROUTES.navBack, {})
    if (result?.ok === false) window.history.back()
  } catch {
    window.history.back()
  } finally {
    backButton.disabled = false
  }
})

reloadButton.addEventListener('click', async () => {
  if (reloadButton.disabled || !targetUrl) return
  reloadButton.disabled = true
  try {
    const result = await rpc<{ ok?: boolean }>(IPC_ROUTES.safeBrowsingContinue, { url: targetUrl })
    if (result?.ok !== true) throw new Error('continue rejected')
  } catch {
    reloadButton.disabled = false
    requiredElement<HTMLElement>('reason').textContent = '无法继续前往该页面，请返回后重试。'
  }
})

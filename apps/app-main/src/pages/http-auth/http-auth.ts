/**
 * HTTP Basic / 代理认证弹窗。
 *
 * 数据与生命周期全部在主进程（`main/http-auth.js`）：那边在 app 的 `login` 事件里
 * 把请求挂起，本页面只负责「展示是哪个站点要凭据 + 收集用户名密码」。
 *
 * 安全性约束：这里的每一次交互都必须带上 `requestId` —— 主进程只接受与当前挂起
 * 请求匹配的提交，因此并发登录不会串号（不会把 A 站的账号送给 B 站）。
 */
import { IPC_ROUTES, rpc, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, requiredById } from 'hira://shared/page-kit.js'

interface HttpAuthInfo {
  requestId: string
  isProxy?: boolean
  schemeLabel?: string
  host?: string
  realm?: string
}

interface HttpAuthResult {
  ok?: boolean
}

initTheme()

const titleEl = requiredById<HTMLElement>('ha-title')
const hostEl = requiredById<HTMLElement>('ha-host')
const realmEl = requiredById<HTMLElement>('ha-realm')
const noteEl = requiredById<HTMLElement>('ha-note')
const fieldsEl = requiredById<HTMLElement>('ha-fields')
const usernameEl = requiredById<HTMLInputElement>('ha-username')
const passwordEl = requiredById<HTMLInputElement>('ha-password')
const submitBtn = requiredById<HTMLButtonElement>('ha-submit')
const cancelBtn = requiredById<HTMLButtonElement>('ha-cancel')

/** 本次弹窗对应的请求 id；拿不到就说明请求已失效。 */
let requestId: string | null = null

function showNote (text: string): void {
  noteEl.hidden = false
  noteEl.textContent = text
}

function lockForm (): void {
  fieldsEl.hidden = true
  submitBtn.disabled = true
  cancelBtn.textContent = '关闭'
}

function setBusy (busy: boolean): void {
  submitBtn.disabled = busy
  cancelBtn.disabled = busy
  submitBtn.textContent = busy ? '登录中…' : '登录'
}

async function boot (): Promise<void> {
  let info: HttpAuthInfo | null = null
  try {
    info = await rpc<HttpAuthInfo | null>(IPC_ROUTES.httpAuthReady, {})
  } catch (e) {
    showNote(`无法读取认证请求：${errorMessage(e)}`)
    lockForm()
    return
  }

  if (!info) {
    // 主进程没有挂起的请求（超时已被取消 / 窗口比请求活得久）
    showNote('这次登录请求已失效，请重新加载页面。')
    lockForm()
    return
  }

  requestId = info.requestId
  titleEl.textContent = info.isProxy ? '需要代理认证' : '需要登录'
  hostEl.textContent = [info.schemeLabel, info.host].filter(Boolean).join(' · ')
  if (info.realm) {
    realmEl.textContent = `领域：${info.realm}`
    realmEl.hidden = false
  }
  usernameEl.focus()
}

async function submit (): Promise<void> {
  if (!requestId) return
  setBusy(true)
  try {
    // 不关闭窗口：主进程在放行请求后会销毁它。若提交被拒（requestId 不匹配），
    // 这里必须把界面解锁并说明原因，否则用户会卡在「登录中…」。
    const res = await rpc<HttpAuthResult>(IPC_ROUTES.httpAuthSubmit, {
      requestId,
      username: usernameEl.value || '',
      password: passwordEl.value || ''
    })
    if (!res || res.ok !== true) {
      setBusy(false)
      showNote('这次登录请求已失效，请重新加载页面。')
      lockForm()
    }
  } catch (e) {
    setBusy(false)
    showNote(`提交失败：${errorMessage(e)}`)
  }
}

async function cancel (): Promise<void> {
  if (!requestId) {
    window.close()
    return
  }
  try {
    await rpc(IPC_ROUTES.httpAuthCancel, { requestId })
  } catch (_) {
    // 取消失败也要让用户能关掉窗口 —— 主进程侧有关窗兜底（closed → 取消请求）
  }
  window.close()
}

submitBtn.addEventListener('click', submit)
cancelBtn.addEventListener('click', cancel)

usernameEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    passwordEl.focus()
  }
})

passwordEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
})

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
})

boot()

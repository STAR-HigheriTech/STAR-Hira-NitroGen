import { IPC_ROUTES, rpc, initTheme } from 'hira://shared/runtime.js'

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`View source element #${id} is unavailable`)
  return element as unknown as T
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const urlEl = requiredElement<HTMLElement>('source-url')
const sourceEl = requiredElement<HTMLElement>('source')

// 只读保证：contenteditable 元素默认可编辑，这里把**所有写入入口**逐个拦死，
// 只保留插入符与选区 —— 正是「可定位的只读视图」要的效果。
// 覆盖：键盘输入 / 输入法 / 粘贴 / 剪切 / 拖放文本。
for (const type of ['beforeinput', 'paste', 'cut', 'drop']) {
  sourceEl.addEventListener(type, (event) => event.preventDefault())
}
const copyBtn = requiredElement<HTMLButtonElement>('copy')
const stateEl = requiredElement<HTMLElement>('copy-state')

/** 上一次成功取到的源码；为 null 表示取不到（页面已关闭 / 无权限）。 */
let html: string | null = null

async function load () {
  html = null
  copyBtn.disabled = true
  stateEl.textContent = ''
  urlEl.textContent = '正在向主进程请求当前活动标签的源码…'
  sourceEl.textContent = '读取中…'

  let res: { url?: string; html?: unknown } | null = null
  try {
    res = await rpc<{ url?: string; html?: unknown }>(IPC_ROUTES.pageViewSource, {})
  } catch (error) {
    urlEl.textContent = '读取失败'
    sourceEl.textContent = '读取失败：' + errorText(error, String(error))
    return
  }

  urlEl.textContent = res && res.url ? String(res.url) : '（未取到来源地址）'

  if (!res || typeof res.html !== 'string') {
    sourceEl.textContent = '无法获取（页面已关闭或无权限）'
    return
  }

  html = res.html
  // 纯文本写入：页面源码绝不走 innerHTML，避免把它当成标记解析（XSS 面）
  sourceEl.textContent = html
  copyBtn.disabled = html.length === 0
}

/** 剪贴板 API（hira:// 是 secure 上下文，通常可用）。 */
async function copyWithClipboard (text: string): Promise<void> {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    throw new Error('剪贴板 API 不可用')
  }
  await navigator.clipboard.writeText(text)
}

/** 回退路径：离线环境下的 execCommand 复制。 */
function copyWithTextarea (text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch (_) { ok = false }
  document.body.removeChild(area)
  return ok
}

copyBtn.onclick = async () => {
  if (html === null) return
  try {
    await copyWithClipboard(html)
    stateEl.textContent = '已复制'
    return
  } catch (error) {
    stateEl.textContent = copyWithTextarea(html)
      ? '已复制（回退方式）'
      : '复制失败：' + errorText(error, String(error))
  }
}

requiredElement<HTMLButtonElement>('refresh').onclick = load
load()

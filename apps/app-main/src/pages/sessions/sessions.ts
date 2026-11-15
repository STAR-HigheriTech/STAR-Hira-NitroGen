/*
 * 会话管理页（N14）—— `hira://sessions`
 *
 * 与 settings / passwords 同构的**静态内部页**（无打包器）：只认标准 preload 桥与
 * `session:named-*` 四条路由。形状与上限在纯层（shared-types#named-sessions），
 * 存储与开标签在主进程（main/named-sessions.js）—— 本页只负责画与转发意图。
 */
import { rpc, el, fmtTime, renderEmpty, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, isRecord, requiredById } from 'hira://shared/page-kit.js'

interface NamedSession {
  id: string
  name: string
  tabs?: unknown[]
  createdAt?: number | string
  spaceId?: string
}

interface SessionOperation {
  ok?: boolean
  reason?: string
  opened?: number
}

interface SessionListResponse {
  sessions?: unknown
}

initTheme()

const messageHost = requiredById<HTMLElement>('message')
const listHost = requiredById<HTMLElement>('list')
const countEl = requiredById<HTMLElement>('count')
const nameInput = requiredById<HTMLInputElement>('name')
const saveButton = requiredById<HTMLButtonElement>('save')
const refreshButton = requiredById<HTMLButtonElement>('refresh')

/** 一行会话：名称 + 元信息 + 恢复 / 删除。 */
function buildRow (session: NamedSession, refresh: () => Promise<void>): HTMLElement {
  const row = el('div', 'row')
  const info = el('div', 'info')
  info.appendChild(el('div', 'name', session.name))

  const meta = [`${(session.tabs || []).length} 个标签`]
  if (session.createdAt) meta.push('保存于 ' + fmtTime(session.createdAt))
  if (session.spaceId) meta.push('空间 ' + session.spaceId)
  info.appendChild(el('div', 'meta', meta.join(' · ')))
  row.appendChild(info)

  const restore = el('button', 'btn', '恢复')
  restore.onclick = async () => {
    restore.disabled = true
    restore.textContent = '恢复中…'
    try {
      const res = await rpc<SessionOperation>('session:named-restore', { id: session.id })
      showMessage(
        res?.ok ? `已打开 ${res.opened || 0} 个标签。` : (res?.reason || '恢复失败'),
        Boolean(res?.ok)
      )
    } catch (_) {
      showMessage('恢复失败', false)
    } finally {
      restore.disabled = false
      restore.textContent = '恢复'
    }
  }
  row.appendChild(restore)

  const remove = el('button', 'icon-btn', '\u2715')
  remove.title = '删除该会话'
  remove.onclick = async () => {
    await rpc('session:named-remove', { id: session.id })
    refresh()
  }
  row.appendChild(remove)
  return row
}

function showMessage (text?: string, ok = false): void {
  messageHost.textContent = ''
  if (!text) return
  const row = el('div', 'row')
  row.appendChild(el('div', 'meta', (ok ? '' : '⚠ ') + text))
  messageHost.appendChild(row)
}

async function refresh (): Promise<void> {
  const response = await rpc<SessionListResponse>('session:named-list', {}).catch(() => null)
  const sessions = Array.isArray(response?.sessions)
    ? response.sessions.filter(isRecord) as unknown as NamedSession[]
    : []

  listHost.textContent = ''
  countEl.textContent = sessions.length ? `(${sessions.length})` : ''
  if (!sessions.length) {
    renderEmpty(listHost, '还没有保存任何会话。给当前这组标签起个名字就能存下来。')
    return
  }
  sessions.forEach((session: NamedSession) => listHost.appendChild(buildRow(session, refresh)))
}

refreshButton.onclick = () => refresh()

saveButton.onclick = async () => {
  const name = (nameInput.value || '').trim()
  if (!name) return nameInput.focus()
  try {
    const res = await rpc<SessionOperation>('session:named-save', { name })
    if (res && res.ok) {
      nameInput.value = ''
      showMessage(`已保存会话「${name}」。`, true)
    } else {
      showMessage((res && res.reason) || '保存失败', false)
    }
  } catch (_) {
    showMessage('保存失败', false)
  }
  refresh()
}
nameInput.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter') saveButton.click()
})

refresh().catch((error?) => {
  console.error('[sessions] load failed:', errorMessage(error))
})

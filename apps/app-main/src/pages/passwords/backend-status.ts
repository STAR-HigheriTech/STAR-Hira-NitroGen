import { el } from 'hira://shared/runtime.js'
import { passwordsClient } from './client.js'
import type {
  BackendActionName,
  BackendActionResult,
  PasswordBackend,
  PasswordBackendStatus
} from './types.js'

const SIGN_IN_REASONS = new Set([
  'bitwarden-not-logged-in',
  'onepassword-not-signed-in'
])

function messageOf(result?: BackendActionResult): string {
  if (!result) return '操作失败'
  return result.message || result.reason || '操作失败'
}

function runAction(
  backend: PasswordBackend,
  action: BackendActionName,
  payload: Record<string, string> = {}
): Promise<BackendActionResult> {
  return passwordsClient.backendAction(backend, action, payload)
}

function runInstall(name: string): Promise<BackendActionResult> {
  return passwordsClient.installTool(name)
}

function actionButton(label: string, onClick: () => Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn', label)
  button.onclick = async () => {
    button.disabled = true
    try {
      await onClick()
    } finally {
      button.disabled = false
    }
  }
  return button
}

function hint(text: string): HTMLElement {
  return el('div', 'backend-status-hint', text)
}

function actions(): HTMLElement {
  return el('div', 'backend-status-actions')
}

function field(placeholder: string, type: 'text' | 'password' | 'email' = 'text', label = ''): HTMLInputElement {
  const input = el('input', 'search')
  input.type = type
  input.placeholder = placeholder
  if (label) input.setAttribute('aria-label', label)
  input.autocomplete = 'off'
  input.spellcheck = false
  return input
}

function buildSignIn(
  backend: PasswordBackend,
  status: PasswordBackendStatus,
  refresh: () => Promise<void>,
  note: HTMLElement
): HTMLElement {
  const box = el('div', 'backend-status-actions backend-status-signin')
  const inputs = new Map<string, HTMLInputElement>()

  for (const item of status.signInFields || []) {
    const label = item.label || item.key
    const input = field(item.placeholder || label, item.type || 'text', label)
    inputs.set(item.key, input)
    box.appendChild(input)
  }

  box.appendChild(actionButton(status.signInLabel || '登录', async () => {
    const payload: Record<string, string> = {}
    for (const [key, input] of inputs) {
      const value = input.value.trim()
      if (value) payload[key] = value
    }
    if (Object.keys(payload).length === 0) {
      note.textContent = '请先填写登录信息。'
      return
    }
    const result = await runAction(backend, 'sign-in', payload)
    if (result.ok) {
      note.textContent = '登录成功，正在刷新状态…'
      await refresh()
      return
    }
    note.textContent = `登录失败：${messageOf(result)}`
  }))

  return box
}

function buildUnlockRow(
  backend: PasswordBackend,
  refresh: () => Promise<void>,
  note: HTMLElement,
  fallbackToSignIn: () => void
): HTMLElement {
  const unlockRow = actions()
  const passwordInput = field('主密码', 'password', '主密码')
  unlockRow.appendChild(passwordInput)
  const unlockButton = actionButton('解锁', async () => {
    const password = passwordInput.value
    if (!password) {
      passwordInput.focus()
      return
    }
    const result = await runAction(backend, 'unlock', { password })
    passwordInput.value = ''
    if (result.ok) {
      note.textContent = ''
      await refresh()
      return
    }
    note.textContent = messageOf(result)
    if (result.reason && SIGN_IN_REASONS.has(result.reason)) fallbackToSignIn()
  })
  unlockRow.appendChild(unlockButton)
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') unlockButton.click()
  })
  return unlockRow
}

function renderUnlockMode(
  slot: HTMLElement,
  backend: PasswordBackend,
  refresh: () => Promise<void>,
  note: HTMLElement
): void {
  const status = backend.status
  if (!status) return
  slot.textContent = ''
  const showSignIn = status.signInRequired === true

  if (showSignIn) {
    slot.appendChild(buildSignIn(backend, status, refresh, note))
    if (status.signInHint) slot.appendChild(el('div', 'backend-status-note', status.signInHint))
  } else {
    slot.appendChild(buildUnlockRow(backend, refresh, note, () => {
      backend.status = { ...status, signInRequired: true }
      renderUnlockMode(slot, backend, refresh, note)
    }))
    if (status.unlockHint) slot.appendChild(el('div', 'backend-status-note', status.unlockHint))
    if (status.signInHint) slot.appendChild(el('div', 'backend-status-note', status.signInHint))
  }

  const toggle = el('button', 'link-btn', showSignIn ? '已登录？改用主密码解锁' : (status.signInLabel || '登录账号'))
  toggle.onclick = () => {
    backend.status = { ...status, signInRequired: !showSignIn }
    renderUnlockMode(slot, backend, refresh, note)
  }
  slot.appendChild(toggle)
}

export function buildBackendStatus(
  backend: PasswordBackend,
  refresh: () => Promise<void>
): HTMLElement | null {
  const status = backend.status
  if (!status) return null

  const host = el('div', 'backend-status')
  const note = el('div', 'backend-status-note')
  const toolName = status.toolFileName || 'CLI'

  if (status.toolFound !== true || status.versionOk !== true) {
    const problem = status.toolFound !== true
      ? `未检测到 ${toolName}。`
      : `${toolName} 版本过低（当前 ${status.version || '未知'}，需要 ${status.minVersion || '更新版本'} 及以上）。`
    host.appendChild(hint(problem))

    const row = actions()
    row.appendChild(actionButton(
      status.installMode === 'download' ? '打开下载页' : '选择文件安装',
      async () => {
        const result = await runInstall(backend.name)
        if (result.ok) {
          note.textContent = result.message || '已就绪。'
          await refresh()
          return
        }
        if (result.reason !== 'cancelled') note.textContent = messageOf(result)
      }
    ))
    row.appendChild(actionButton('重新检测', async () => {
      const result = await runAction(backend, 'probe')
      if (result.ok) {
        note.textContent = ''
        await refresh()
      } else {
        note.textContent = messageOf(result)
      }
    }))
    host.appendChild(row)
    host.appendChild(note)
    return host
  }

  const versionText = status.version ? ` · v${status.version}` : ''
  host.appendChild(hint(`${toolName} 已就绪${versionText} · ${status.unlocked ? '已解锁' : '尚未解锁'}`))

  if (status.unlocked) {
    const row = actions()
    if (status.actions?.sync) {
      row.appendChild(actionButton('同步密码库', async () => {
        const result = await runAction(backend, 'sync')
        note.textContent = result.ok ? '已同步。' : `同步失败：${messageOf(result)}`
      }))
    }
    if (row.childElementCount) host.appendChild(row)
    if (status.unlockedHint) host.appendChild(el('div', 'backend-status-note', status.unlockedHint))
    return host
  }

  const modeSlot = el('div', 'backend-status-mode')
  host.appendChild(modeSlot)
  host.appendChild(note)
  renderUnlockMode(modeSlot, backend, refresh, note)
  return host
}

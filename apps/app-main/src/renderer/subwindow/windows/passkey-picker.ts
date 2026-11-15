import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { PasskeyPickerPayload } from '@hira-ng/shared-types/src/passkey.mjs'
import type { SubwindowMountContext } from './contract.js'

const CSS = `
  .passkey-picker { display:flex; flex-direction:column; gap:12px; height:100%; }
  .passkey-picker__intro { font-size:13px; line-height:1.55; opacity:.72; }
  .passkey-picker__host { font-weight:600; color:var(--hira-text-primary,#1a1a1a); }
  .passkey-picker__list { display:flex; flex-direction:column; gap:6px; flex:1; min-height:0; overflow:auto; padding:2px; }
  .passkey-picker__account {
    display:flex; align-items:center; gap:10px; width:100%; min-height:48px; padding:8px 10px;
    border:1px solid var(--hira-border-subtle,rgba(0,0,0,.12));
    border-radius:var(--hira-radius-sm,8px); background:transparent; color:inherit;
    text-align:left; font:inherit; cursor:default;
  }
  .passkey-picker__account:hover,
  .passkey-picker__account:focus-visible {
    background:var(--hira-hover-bg,rgba(0,0,0,.045));
    border-color:var(--hira-border-strong,rgba(0,0,0,.24));
    outline:none;
  }
  .passkey-picker__avatar {
    width:30px; height:30px; border-radius:50%; display:grid; place-items:center;
    flex-shrink:0; background:var(--hira-accent-soft,rgba(0,120,212,.12));
    color:var(--hira-accent,#0b6bbd); font-size:13px; font-weight:700;
  }
  .passkey-picker__meta { min-width:0; display:flex; flex-direction:column; gap:2px; }
  .passkey-picker__name { font-size:13.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .passkey-picker__id { font-size:11.5px; opacity:.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .passkey-picker__footer { display:flex; justify-content:flex-end; gap:8px; }
  .passkey-picker__btn {
    min-width:82px; height:30px; padding:0 14px; border-radius:var(--hira-radius-2xs,4px);
    border:1px solid var(--hira-border-subtle,rgba(0,0,0,.16)); background:transparent;
    color:inherit; font:inherit; font-size:13px; cursor:default;
  }
  .passkey-picker__btn:hover { background:var(--hira-hover-bg,rgba(0,0,0,.05)); }
  .passkey-picker__error { color:var(--hira-danger,#c62828); font-size:12px; }
`

function parsePayload(params: URLSearchParams): PasskeyPickerPayload | null {
  try {
    const value = JSON.parse(params.get('payload') || '{}')
    if (!value || !Array.isArray(value.accounts)) return null
    return value as PasskeyPickerPayload
  } catch {
    return null
  }
}

function invoke(route: string, payload: unknown): Promise<unknown> {
  const api = globalThis.window?.hira
  if (!api?.provider || typeof api.provider.invoke !== 'function') {
    return Promise.reject(new Error('window.hira.provider is unavailable'))
  }
  return api.provider.invoke(route, payload)
}

export function mountPasskeyPicker({ params, content }: SubwindowMountContext): void {
  if (!document.getElementById('passkey-picker-css')) {
    const style = document.createElement('style')
    style.id = 'passkey-picker-css'
    style.textContent = CSS
    document.head.appendChild(style)
  }
  content.textContent = ''
  const payload = parsePayload(params)
  if (!payload?.requestId || payload.accounts.length === 0) {
    const error = document.createElement('p')
    error.className = 'passkey-picker__error'
    error.textContent = '登录请求已失效，请回到网页重试。'
    content.appendChild(error)
    return
  }

  const root = document.createElement('div')
  root.className = 'passkey-picker'
  const intro = document.createElement('div')
  intro.className = 'passkey-picker__intro'
  const host = document.createElement('strong')
  host.className = 'passkey-picker__host'
  host.textContent = payload.relyingPartyId
  intro.append('选择用于登录 ', host, ' 的 Passkey。私钥由系统认证器保管，不会交给 Hira。')

  const list = document.createElement('div')
  list.className = 'passkey-picker__list'
  list.setAttribute('role', 'listbox')
  const status = document.createElement('div')
  status.className = 'passkey-picker__error'
  let busy = false

  const finish = async (credentialId: string | null) => {
    if (busy) return
    busy = true
    try {
      await invoke(IPC_ROUTES.passkeySelect, { requestId: payload.requestId, credentialId })
      window.close()
    } catch {
      busy = false
      status.textContent = '无法完成选择，请重试。'
    }
  }

  for (const account of payload.accounts) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'passkey-picker__account'
    button.setAttribute('role', 'option')
    const display = account.displayName || account.name || 'Passkey'
    const avatar = document.createElement('span')
    avatar.className = 'passkey-picker__avatar'
    avatar.textContent = display.trim().slice(0, 1).toUpperCase() || 'P'
    const meta = document.createElement('span')
    meta.className = 'passkey-picker__meta'
    const name = document.createElement('span')
    name.className = 'passkey-picker__name'
    name.textContent = display
    const id = document.createElement('span')
    id.className = 'passkey-picker__id'
    id.textContent = account.name && account.name !== display ? account.name : '设备 Passkey'
    meta.append(name, id)
    button.append(avatar, meta)
    button.addEventListener('click', () => { void finish(account.credentialId) })
    list.appendChild(button)
  }

  const footer = document.createElement('div')
  footer.className = 'passkey-picker__footer'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'passkey-picker__btn'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => { void finish(null) })
  footer.appendChild(cancel)
  root.append(intro, list, status, footer)
  content.appendChild(root)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      void finish(null)
    }
  })
  requestAnimationFrame(() => {
    const first = list.querySelector<HTMLButtonElement>('button')
    first?.focus()
  })
}

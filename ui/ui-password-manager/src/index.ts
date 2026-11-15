// @ts-check
/**
 * ui-password-manager — PasswordCaptureBar + PasswordViewer
 *
 * PART5 S5-5 / PART8 Week 12:
 *   PasswordCaptureBar: 保存密码提示条（登录时弹出，"保存"/"永不保存此域名"）
 *   PasswordViewer:     已保存密码列表查看器
 *
 * 对齐旧 Hira passwordManager.js + passwordCaptureBar UI
 * 通过 IPC 调用 domain-password 服务
 */

const PASSWORD_STYLE = `
.password-capture-bar {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%) translateY(100%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--password-bar-bg, #fff);
  border: 1px solid var(--password-bar-border, rgba(0,0,0,0.1));
  border-radius: var(--hira-radius-sm, 8px);
  box-shadow: 0 2px 12px rgba(0,0,0,0.12);
  z-index: var(--hira-z-popover); /* 保存密码提示条（浮于内容之上的提示卡）= popover */
  font-size: 13px;
  color: var(--text-primary, #000);
  transition: transform 0.2s ease;
}
.password-capture-bar.visible {
  transform: translateX(-50%) translateY(-10px);
}
.password-capture-bar__text {
  flex: 1;
  white-space: nowrap;
}
.password-capture-bar__btn {
  border: none;
  padding: 6px 14px;
  border-radius: var(--hira-radius-2xs, 4px);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
}
.password-capture-bar__btn--save {
  background: var(--hira-accent, #1a73e8);
  color: var(--hira-on-accent, #fff);
}
.password-capture-bar__btn--save:hover {
  background: color-mix(in srgb, var(--hira-accent, #1a73e8) 88%, #000);
}
.password-capture-bar__btn--never {
  background: transparent;
  color: var(--text-secondary, #666);
}
.password-capture-bar__btn--never:hover {
  background: var(--button-hover-bg, rgba(0,0,0,0.06));
}
.password-capture-bar__btn--close {
  background: transparent;
  color: var(--text-secondary, #666);
  padding: 4px 8px;
  font-size: 16px;
  line-height: 1;
}
.password-capture-bar__btn--close:hover {
  color: var(--text-primary, #000);
}

.password-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel-bg, #fff);
}
.password-viewer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color, rgba(0,0,0,0.08));
}
.password-viewer__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #000);
}
.password-viewer__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.password-viewer__item {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  gap: 10px;
  cursor: default;
}
.password-viewer__item:hover {
  background: var(--list-hover-bg, rgba(0,0,0,0.04));
}
.password-viewer__item-domain {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary, #000);
}
.password-viewer__item-username {
  font-size: 12px;
  color: var(--text-secondary, #666);
}
.password-viewer__item-delete {
  border: none;
  background: transparent;
  color: var(--text-secondary, #999);
  cursor: pointer;
  padding: 4px;
  font-size: 14px;
  opacity: 0;
  transition: opacity 0.15s;
}
.password-viewer__item:hover .password-viewer__item-delete {
  opacity: 1;
}
.password-viewer__item-delete:hover {
  color: var(--hira-danger, #e53935);
}
.password-viewer__empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-secondary, #999);
  font-size: 13px;
}
`

export interface PasswordCredentialInput {
  hostname: string
  username: string
  password: string
}

export interface PasswordCredential {
  id: string | number
  hostname?: string
  domain?: string
  username?: string
}

export type PasswordInvoke = (channel: string, payload?: unknown) => Promise<unknown>

export interface PasswordCaptureOptions {
  doc?: Document
  invoke?: PasswordInvoke
}

export interface PasswordCaptureBar {
  readonly element: HTMLElement
  show(data: PasswordCredentialInput): void
  hide(): void
  shouldShow(hostname: string): Promise<boolean>
}

export interface PasswordViewerOptions {
  doc?: Document
  invoke?: PasswordInvoke
}

export interface PasswordViewer {
  readonly element: HTMLElement
  refresh(): Promise<void>
}

/** 注入样式。 */
export function injectPasswordManagerStyles(doc: Document): void {
  const style = doc.createElement('style')
  style.textContent = PASSWORD_STYLE
  doc.head.appendChild(style)
}

/** 保存密码提示条；IPC 通过端口注入，组件不依赖 Electron。 */
export function createPasswordCaptureBar(options: PasswordCaptureOptions = {}): PasswordCaptureBar {
  const doc = options.doc || document
  const invoke = options.invoke || (() => Promise.resolve())

  const bar = doc.createElement('div')
  bar.className = 'password-capture-bar'

  const text = doc.createElement('span')
  text.className = 'password-capture-bar__text'
  bar.appendChild(text)

  const saveBtn = doc.createElement('button')
  saveBtn.className = 'password-capture-bar__btn password-capture-bar__btn--save'
  saveBtn.textContent = '保存'
  bar.appendChild(saveBtn)

  const neverBtn = doc.createElement('button')
  neverBtn.className = 'password-capture-bar__btn password-capture-bar__btn--never'
  neverBtn.textContent = '永不保存'
  bar.appendChild(neverBtn)

  const closeBtn = doc.createElement('button')
  closeBtn.className = 'password-capture-bar__btn password-capture-bar__btn--close'
  closeBtn.textContent = '×'
  closeBtn.title = '关闭'
  bar.appendChild(closeBtn)

  let currentData: PasswordCredentialInput | null = null

  function hide() {
    bar.classList.remove('visible')
    currentData = null
  }

  function show(data: PasswordCredentialInput) {
    currentData = data
    text.textContent = `保存 ${data.hostname} 的密码？`
    bar.classList.add('visible')
  }

  saveBtn.addEventListener('click', async () => {
    if (!currentData) return
    try {
      await invoke('password:save', {
        hostname: currentData.hostname,
        username: currentData.username,
        password: currentData.password
      })
    } catch (_) {}
    hide()
  })

  neverBtn.addEventListener('click', async () => {
    if (!currentData) return
    try {
      await invoke('password:never-save:add', { hostname: currentData.hostname })
    } catch (_) {}
    hide()
  })

  closeBtn.addEventListener('click', hide)

  // 5 秒后自动消失
  let autoHideTimer: ReturnType<typeof setTimeout> | null = null
  const originalShow = show
  function showWithAutoHide(data: PasswordCredentialInput) {
    originalShow(data)
    if (autoHideTimer) clearTimeout(autoHideTimer)
    autoHideTimer = setTimeout(hide, 5000)
  }

  return {
    element: bar,
    show: showWithAutoHide,
    hide,
    /** 检查域名是否在永不保存列表中，是则不弹出 */
    async shouldShow(hostname: string) {
      try {
        const neverList = await invoke('password:never-save:list')
        if (Array.isArray(neverList) && neverList.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
          return false
        }
      } catch (_) {}
      return true
    }
  }
}

/** 已保存密码列表查看器。 */
export async function createPasswordViewer(options: PasswordViewerOptions = {}): Promise<PasswordViewer> {
  const doc = options.doc || document
  const invoke = options.invoke || (() => Promise.resolve())

  const container = doc.createElement('div')
  container.className = 'password-viewer'

  const header = doc.createElement('div')
  header.className = 'password-viewer__header'
  const title = doc.createElement('span')
  title.className = 'password-viewer__title'
  title.textContent = '已保存的密码'
  header.appendChild(title)
  container.appendChild(header)

  const list = doc.createElement('div')
  list.className = 'password-viewer__list'
  container.appendChild(list)

  async function refresh(): Promise<void> {
    list.innerHTML = ''
    let credentials: PasswordCredential[] = []
    try {
      const result = await invoke('password:list')
      if (Array.isArray(result)) credentials = result as PasswordCredential[]
    } catch (_) {}

    if (!credentials || credentials.length === 0) {
      const empty = doc.createElement('div')
      empty.className = 'password-viewer__empty'
      empty.textContent = '暂无保存的密码'
      list.appendChild(empty)
      return
    }

    for (const cred of credentials) {
      const item = doc.createElement('div')
      item.className = 'password-viewer__item'

      const domain = doc.createElement('span')
      domain.className = 'password-viewer__item-domain'
      domain.textContent = cred.domain || cred.hostname || ''
      item.appendChild(domain)

      const username = doc.createElement('span')
      username.className = 'password-viewer__item-username'
      username.textContent = cred.username || ''
      item.appendChild(username)

      const delBtn = doc.createElement('button')
      delBtn.className = 'password-viewer__item-delete'
      delBtn.textContent = '×'
      delBtn.title = '删除'
      delBtn.addEventListener('click', async () => {
        try {
          await invoke('password:delete', { id: cred.id })
          refresh()
        } catch (_) {}
      })
      item.appendChild(delBtn)

      list.appendChild(item)
    }
  }

  await refresh()

  return {
    element: container,
    refresh
  }
}

export default {
  injectPasswordManagerStyles,
  createPasswordCaptureBar,
  createPasswordViewer
}

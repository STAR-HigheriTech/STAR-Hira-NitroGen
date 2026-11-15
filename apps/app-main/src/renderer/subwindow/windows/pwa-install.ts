/**
 * PWA 安装确认框（`WINDOW_TYPES.PWA_INSTALL`）。
 *
 * ── 它只是**确认**，不是权威 ─────────────────────────────────────────
 * 应用名、start_url、图标、完整/简化全部由主进程探测（`pwa:prepare`），
 * 本模块只把预览摆出来、收集三个开关、把 `candidateId` + 开关发回去。
 * 安装管线需要的图标下载、目录替换、数据库、快捷方式都在主进程 ——
 * 这里绝不自己拼任何应用信息（否则一个被注入的页面就能伪造 start_url）。
 *
 * ── 打开方式 ───────────────────────────────────────────────────────
 * 走 `window:open` 通用链路：
 *   payload = { candidateId, preview: { appId, name, shortName, kind, origin,
 *               startUrl, themeColor, iconUrl, installedId } }
 * 主进程把 payload 序列化成 `?payload=<json>` 附在 URL 上（见 main.js）。
 *
 * 解耦原则：不 import infra / domain，只经 `window.hira` 说话。
 */

import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { SubwindowMountContext } from './contract.js'

/** 安装阶段 → 文案。阶段的权威在 `main/pwa/install.js#STAGES`，这里只做翻译。 */
const STAGE_TEXT: Record<string, string> = {
  icon: '正在获取应用图标…',
  db: '正在注册应用…',
  shortcut: '正在创建快捷方式…'
}

const CSS = `
  .pwa-install {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
  }
  .pwa-install__head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .pwa-install__icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: var(--hira-radius-sm, 8px);
    object-fit: contain;
    background: var(--hira-field-bg, rgba(0, 0, 0, 0.06));
  }
  .pwa-install__icon[hidden] { display: none; }
  .pwa-install__meta {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pwa-install__name {
    width: 100%;
    min-width: 0;
    margin: 0 0 0 -5px;
    padding: 1px 5px;
    border: 1px solid transparent;
    border-radius: var(--hira-radius-2xs, 4px);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    line-height: 20px;
    outline: none;
    text-overflow: ellipsis;
  }
  .pwa-install__name:hover {
    border-color: var(--hira-border-subtle, rgba(0, 0, 0, 0.16));
  }
  .pwa-install__name:focus {
    border-color: var(--hira-accent, #3b82f6);
    background: var(--hira-hover-bg, rgba(0, 0, 0, 0.03));
  }
  .pwa-install__name[disabled] { opacity: 0.6; }
  .pwa-install__origin {
    font-size: 12px;
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pwa-install__badge {
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: var(--hira-radius-md, 10px);
    font-size: 11.5px;
    background: var(--hira-accent-soft, rgba(0, 120, 212, 0.12));
    color: var(--hira-accent, #0b6bbd);
  }
  .pwa-install__options {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0;
    border-top: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.08));
    border-bottom: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.08));
  }
  .pwa-install__option {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 30px;
    font-size: 13px;
    cursor: default;
    user-select: none;
  }
  .pwa-install__option input {
    width: 14px;
    height: 14px;
    accent-color: var(--hira-accent, #3b82f6);
    cursor: default;
  }
  .pwa-install__status {
    flex: 1;
    min-height: 18px;
    font-size: 12.5px;
    line-height: 18px;
    opacity: 0.75;
    word-break: break-word;
  }
  .pwa-install__status[data-tone="error"] { color: var(--hira-danger, #c62828); opacity: 1; }
  .pwa-install__status[data-tone="warn"] { color: var(--hira-warn, #b26a00); opacity: 1; }
  .pwa-install__footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }
  .pwa-install__btn {
    min-width: 84px;
    height: 30px;
    padding: 0 14px;
    border-radius: var(--hira-radius-2xs, 4px);
    border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.16));
    background: transparent;
    color: inherit;
    font-size: 13px;
    cursor: default;
  }
  .pwa-install__btn:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05)); }
  .pwa-install__btn[data-primary="true"] {
    border-color: transparent;
    background: var(--hira-accent, #3b82f6);
    color: var(--hira-on-accent, #ffffff);
  }
  .pwa-install__btn[data-primary="true"]:hover {
    background: color-mix(in srgb, var(--hira-accent, #3b82f6) 88%, #000);
  }
  .pwa-install__btn[disabled] { opacity: 0.5; pointer-events: none; }
`

function bridge() {
  return globalThis.window ? globalThis.window.hira : null
}

function invoke(route: string, payload?: unknown) {
  const api = bridge()
  if (!api || !api.provider || typeof api.provider.invoke !== 'function') {
    return Promise.reject(new Error('window.hira.provider is unavailable'))
  }
  return api.provider.invoke(route, payload)
}

function parsePayload(params: URLSearchParams): Record<string, unknown> {
  try {
    return JSON.parse(params.get('payload') || '{}') || {}
  } catch (_) {
    return {}
  }
}

export function mountPwaInstall({ params, content }: SubwindowMountContext): void {
  const payload = parsePayload(params)
  const preview = payload.preview && typeof payload.preview === 'object'
    ? payload.preview as Record<string, unknown>
    : {}
  const candidateId = String(payload.candidateId || '')
  const kind = String(preview.kind || '')
  const appName = String(preview.name || '应用')

  if (!document.getElementById('pwa-install-css')) {
    const style = document.createElement('style')
    style.id = 'pwa-install-css'
    style.textContent = CSS
    document.head.appendChild(style)
  }
  content.textContent = ''

  const root = document.createElement('div')
  root.className = 'pwa-install'

  // ── 头部：图标 + 名称 + 来源 + 类型标记 ───────────────────────────
  const head = document.createElement('div')
  head.className = 'pwa-install__head'

  const icon = document.createElement('img')
  icon.className = 'pwa-install__icon'
  icon.alt = ''
  icon.draggable = false
  if (preview.iconUrl) icon.src = String(preview.iconUrl)
  else icon.hidden = true
  icon.addEventListener('error', () => { icon.hidden = true })

  const meta = document.createElement('div')
  meta.className = 'pwa-install__meta'
  const nameEl = document.createElement('input')
  nameEl.type = 'text'
  nameEl.className = 'pwa-install__name'
  nameEl.value = appName
  nameEl.maxLength = 120
  nameEl.spellcheck = false
  nameEl.autocomplete = 'off'
  nameEl.title = '点击可修改应用名称'
  nameEl.setAttribute('aria-label', '应用名称')
  // 聚焦即全选：改名是"整条替换"的意图，不是"在末尾追加"。
  nameEl.addEventListener('focus', () => { try { nameEl.select() } catch (_) {} })
  nameEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); nameEl.blur() }
  })
  const originEl = document.createElement('div')
  originEl.className = 'pwa-install__origin'
  originEl.textContent = String(preview.origin || preview.startUrl || '')
  meta.appendChild(nameEl)
  meta.appendChild(originEl)

  const badge = document.createElement('span')
  badge.className = 'pwa-install__badge'
  badge.textContent = kind === 'full' ? '完整应用' : '简化应用'

  head.appendChild(icon)
  head.appendChild(meta)
  head.appendChild(badge)

  // ── 三个开关：桌面 / 开始菜单默认开，开机启动默认关 ──────────────
  const options = document.createElement('div')
  options.className = 'pwa-install__options'
  const checkbox = (label: string, checked: boolean) => {
    const row = document.createElement('label')
    row.className = 'pwa-install__option'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    const text = document.createElement('span')
    text.textContent = label
    row.appendChild(input)
    row.appendChild(text)
    options.appendChild(row)
    return input
  }
  const desktopInput = checkbox('创建桌面快捷方式', true)
  const startMenuInput = checkbox('添加到开始菜单', true)
  const startupInput = checkbox('开机时启动', false)

  // ── 状态行：阶段文案 / 错误就地展示（不弹系统框）──────────────────
  const status = document.createElement('div')
  status.className = 'pwa-install__status'
  const setStatus = (text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' = 'neutral') => {
    status.textContent = text || ''
    if (tone) status.dataset.tone = tone
    else delete status.dataset.tone
  }

  // ── 底部按钮 ─────────────────────────────────────────────────────
  const footer = document.createElement('div')
  footer.className = 'pwa-install__footer'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'pwa-install__btn'
  cancelBtn.textContent = '取消'
  const installBtn = document.createElement('button')
  installBtn.type = 'button'
  installBtn.className = 'pwa-install__btn'
  installBtn.dataset.primary = 'true'
  installBtn.textContent = preview.installedId ? '重新安装' : '安装'
  footer.appendChild(cancelBtn)
  footer.appendChild(installBtn)

  root.appendChild(head)
  root.appendChild(options)
  root.appendChild(status)
  root.appendChild(footer)
  content.appendChild(root)

  let busy = false
  let done = false

  const close = () => {
    try { window.close() } catch (_) {}
  }

  cancelBtn.addEventListener('click', () => { if (!busy) close() })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) close()
  })

  if (!candidateId) {
    setStatus('安装信息已失效，请回到页面重新尝试。', 'error')
    installBtn.disabled = true
    cancelBtn.textContent = '关闭'
    return
  }

  const unsubscribers: Array<() => void> = []
  const api = bridge()
  if (api?.on && typeof api.on.subscribe === 'function') {
    const off = api.on.subscribe(IPC_EVENTS.pwaInstallProgress, (progress) => {
      if (!progress || progress.candidateId !== candidateId) return
      if (done) return
      setStatus(STAGE_TEXT[String(progress.stage)] || '正在安装…')
    })
    if (typeof off === 'function') unsubscribers.push(off)
  }

  installBtn.addEventListener('click', async () => {
    if (busy || done) return
    busy = true
    installBtn.disabled = true
    cancelBtn.disabled = true
    nameEl.disabled = true
    // 只有"改过名字"才把 name 发回去：主进程以 name 是否存在来决定是否覆盖
    // shortName（见 main/pwa/install.js），原样回传会把默认短名误改成全名。
    const editedName = nameEl.value.trim()
    const customName = editedName && editedName !== appName ? editedName : ''
    setStatus('正在安装…')

    try {
      const result = await invoke(IPC_ROUTES.pwaInstall, {
        candidateId,
        ...(customName ? { name: customName } : {}),
        createDesktopShortcut: desktopInput.checked,
        createStartMenuShortcut: startMenuInput.checked,
        runOnStartup: startupInput.checked
      })

      if (!result || !result.ok) {
        setStatus(String((result && result.reason) || '安装失败，请稍后重试。'), 'error')
        busy = false
        installBtn.disabled = false
        cancelBtn.disabled = false
        nameEl.disabled = false
        return
      }

      done = true
      for (const off of unsubscribers) {
        try { off() } catch (_) {}
      }

      const failures = Array.isArray(result.shortcutFailures) ? result.shortcutFailures : []
      if (failures.length) {
        // 安装本身成功：快捷方式失败不该让用户以为整件事失败了。
        const reason = failures[0] && failures[0].reason ? failures[0].reason : '权限不足'
        setStatus(`应用已安装，但快捷方式创建失败：${reason}`, 'warn')
        cancelBtn.disabled = false
        cancelBtn.textContent = '关闭'
        installBtn.textContent = '完成'
        installBtn.disabled = false
        installBtn.onclick = close
        return
      }

      // 先让「安装完成」被看见一帧再关窗：同帧 close 会让成功状态完全不可感知。
      setStatus('安装完成')
      setTimeout(close, 450)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'error')
      busy = false
      installBtn.disabled = false
      cancelBtn.disabled = false
    }
  })
}

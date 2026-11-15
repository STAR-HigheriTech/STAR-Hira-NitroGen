/**
 * Password Overlay Renderer — 完全独立的密码浮层图层。
 *
 * 与 searchbar 下拉 / Permission requests 所在的通用 overlay view 完全解耦：
 * 本页面运行在专属 WebContentsView（passwordOverlay）中，
 * 主进程通过独立 IPC 通道推送显示/隐藏，并由本页自行 set-bounds / set-interactive。
 *
 * 事件（main → 本页，通道名取自 IPC_EVENTS，此处只记 payload 形状）：
 *   - overlayShowPasswordMenu  { hostname, credentials, x, y, windowWidth, windowHeight }
 *   - overlayHidePasswordMenu
 *   - overlayShowPasswordSave  { hostname, username, password, readOnlyBackend, windowWidth, windowHeight }
 *   - overlayHidePasswordSave
 *   - overlayShowPasswordUnlock { backend, displayName, stage, hostname, message, signInLabel,
 *                                 signInHint, signInFields[], unlockHint, windowWidth, windowHeight }
 *   - overlayHidePasswordUnlock
 *
 * 用户操作（本页 → main，IPC_ROUTES.passwordOverlayCommit）：
 *   { kind: 'menu' | 'menu-cancel' | 'save' | 'save-dismiss' | 'save-release'
 *         | 'unlock' | 'sign-in' | 'unlock-cancel', ... }
 *
 * ⚠ 生命周期：保存卡是「待用户决定」的请求，**只由用户操作结束**
 *   （点按钮 / 点空白 / Esc / 被菜单或解锁卡顶掉）。
 *   主进程的导航、刷新、切标签、窗口失焦只收瞬态卡（菜单 / 解锁卡），不会收它。
 *
 * 解锁卡（unlock / sign-in）与保存卡共用一套视觉，只是内容来源不同：
 * 表单字段全部来自后端契约 `signInFields`，本页不认识任何具体厂商。
 *
 * 视图尺寸按需 resize（仅覆盖浮层实际区域 + 阴影 padding），
 * 无浮层时 bounds 为 0x0，不拦截任何下层点击。
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'

// 通道名一律取自契约表（ipc-channels.mjs），本页不手抄字符串。
const ROUTE_COMMIT = IPC_ROUTES.passwordOverlayCommit
const ROUTE_SET_INTERACTIVE = IPC_ROUTES.passwordOverlaySetInteractive
const ROUTE_SET_BOUNDS = IPC_ROUTES.passwordOverlaySetBounds
const ROUTE_READY = IPC_ROUTES.passwordOverlayReady

const themeController = createThemeController({ document, bridge: getHiraBridge() })
themeController.start()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing password overlay root')
const root = rootElement

type PasswordOverlayKind = 'password-menu' | 'password-save' | 'password-unlock'
interface PasswordCredential {
  username?: string
  password?: string
  [key: string]: unknown
}
interface PasswordMenuPayload {
  hostname?: string
  credentials?: PasswordCredential[]
  x?: number
  y?: number
  windowWidth?: number
  windowHeight?: number
}
interface PasswordSavePayload {
  hostname?: string
  username?: string
  password?: string
  readOnlyBackend?: boolean
  windowWidth?: number
  windowHeight?: number
}
interface PasswordSaveState {
  hostname: string
  username: string
  password: string
}

function passwordPreview(password: unknown): string {
  const chars = Array.from(String(password ?? ''))
  if (chars.length === 0) return ''
  const visible = chars.length <= 1 ? 0 : Math.min(2, chars.length - 1)
  return chars.slice(0, visible).join('') + '*'.repeat(chars.length - visible)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 常量 ────────────────────────────────────────────────────
// 顶部不留阴影 padding：view 从卡片上沿开始，避免浮层上方出现一块透明命中区。
const OVERLAY_SIDE_PADDING = 28
const OVERLAY_BOTTOM_PADDING = 28

// ── 互斥状态（本层有密码菜单 / 保存卡 / 解锁卡三张浮层）──────────
let activeOverlay: PasswordOverlayKind | null = null

// 当前展示中的保存卡数据（用于点击空白/Esc 时回传去重）
let currentSavePayload: PasswordSaveState | null = null

// ── 样式（令牌来自 createThemeController，深浅两态由主题令牌统一给出）──
// 这里的 `--pw-*` 只是**本地语义别名**：值全部指向 `--hira-*` 令牌，
// 于是换主题 / 切深浅时本浮层与其它外壳一起变 —— 不再自建一套配色 + 媒体查询。
// （以前 `@media (prefers-color-scheme: dark)` 与 `body.dark` 两份重复声明：
//   前者根本不跟应用主题，后者才生效 —— 两套规则迟早漂移，已删除。）
const style = document.createElement('style')
style.textContent = `
:root {
  --pw-bg: var(--hira-bg-elevated, #ffffff);
  --pw-fg: var(--hira-text-primary, #1a1a1a);
  --pw-fg-secondary: var(--hira-text-secondary, #6b7280);
  --pw-border: var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
  --pw-hover: var(--hira-hover-bg, rgba(128, 128, 128, 0.12));
  --pw-input-border: var(--hira-border-subtle, rgba(0, 0, 0, 0.2));
  --pw-btn-border: var(--hira-border-subtle, rgba(0, 0, 0, 0.2));
  --pw-accent: var(--hira-accent, #4a90d9);
  --pw-on-accent: var(--hira-on-accent, #ffffff);
}
.hira-password-menu, .hira-password-save {
  position: fixed;
  background: var(--pw-bg);
  color: var(--pw-fg);
  border: 1px solid var(--pw-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  display: none;
  pointer-events: auto;
}
.hira-password-menu {
  min-width: 240px;
  max-width: 360px;
  max-height: 240px;
  overflow-y: auto;
  border-radius: var(--hira-theme-radius, 8px);
  padding: 4px;
}
.hira-password-menu__title {
  padding: 6px 10px;
  font-size: 11px;
  opacity: 0.6;
  border-bottom: 1px solid var(--pw-border);
  margin-bottom: 4px;
}
.hira-password-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--hira-radius-xs, 6px);
  cursor: pointer;
  user-select: none;
}
.hira-password-menu__item:hover { background: var(--pw-hover); }
.hira-password-menu__item-un {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.hira-password-menu__item-fill {
  font-size: 11px;
  color: var(--pw-accent);
  flex-shrink: 0;
}
.hira-password-menu__empty {
  padding: 14px;
  text-align: center;
  color: var(--pw-fg-secondary);
  font-size: 13px;
}
.hira-password-save {
  width: 320px;
  border-radius: var(--hira-theme-radius, 12px);
  padding: 16px;
  font-size: 13px;
}
.hira-password-save__title { font-weight: 600; margin-bottom: 4px; font-size: 14px; }
.hira-password-save__host { opacity: 0.6; font-size: 12px; margin-bottom: 12px; }
.hira-password-save__hint { opacity: 0.55; font-size: 11px; line-height: 1.45; margin: -6px 0 10px; }
.hira-password-save__row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.hira-password-save__row label {
  width: 54px; opacity: 0.7; font-size: 12px; flex-shrink: 0;
}
.hira-password-save__row input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--pw-input-border);
  border-radius: var(--hira-radius-xs, 6px);
  font-size: 13px;
  background: transparent;
  color: inherit;
}
.hira-password-save__reveal { cursor: pointer; opacity: 0.6; padding: 0 4px; user-select: none; }
.hira-password-save__actions { display: flex; gap: 8px; margin-top: 12px; }
.hira-password-save__actions button {
  flex: 1;
  padding: 7px 0;
  border-radius: var(--hira-radius-sm, 8px);
  border: 1px solid var(--pw-btn-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.hira-password-save__actions button:hover { background: var(--pw-hover); }
.hira-password-save__actions button[data-action="save"] {
  border: none;
  background: var(--pw-accent);
  color: var(--pw-on-accent);
}
.hira-password-save__actions button[data-action="save"]:hover {
  background: color-mix(in srgb, var(--pw-accent) 88%, #000);
}
/* ── 解锁 / 登录卡（与保存卡同一套视觉，仅内容来源不同）── */
.hira-password-unlock { width: 340px; }
.hira-password-unlock__row label { width: 78px; }
.hira-password-unlock__error {
  color: #d9534f;
  font-size: 12px;
  line-height: 1.4;
  margin: 0 0 8px;
}
.hira-password-unlock__error:empty { display: none; }
.hira-password-unlock__actions button[data-pw-primary="1"] {
  border: none;
  background: var(--pw-accent);
  color: var(--pw-on-accent);
}
.hira-password-unlock__actions button[data-pw-primary="1"]:hover {
  background: color-mix(in srgb, var(--pw-accent) 88%, #000);
}
.hira-password-unlock__switch {
  display: inline-block;
  margin-top: 10px;
  font-size: 12px;
  color: var(--pw-accent);
  cursor: pointer;
  user-select: none;
}
.hira-password-unlock__switch:hover { text-decoration: underline; }
.hira-password-unlock.is-busy button { opacity: 0.6; cursor: default; }
.hira-password-unlock input:focus { outline: 2px solid color-mix(in srgb, var(--pw-accent) 45%, transparent); outline-offset: 1px; }
`
root.appendChild(style)

// ── DOM：多凭据选择菜单 ─────────────────────────────────────
const pwMenu = document.createElement('div')
pwMenu.className = 'hira-password-menu'
root.appendChild(pwMenu)

/**
 * 把浮层 view 钳制在窗口内。
 *
 * ⚠ 此前用"卡片标称宽度"（常量 320）算 x，却用"实测 rect + padding"算 width，
 * 两个数对不上 —— 保存卡实测 354+56=410 宽，x 却按 320 算，右侧直接超出窗口
 * 约 50px 被裁掉。这里统一以**实测尺寸**计算，并保证 x+w / y+h 落在窗口内。
 */
const WINDOW_MARGIN = 12

function clampIntoWindow(x: number, y: number, w: number, h: number, winW: number, winH: number) {
  let nx = Math.round(x)
  let ny = Math.round(y)
  if (winW > 0) {
    const maxX = winW - w - WINDOW_MARGIN
    nx = maxX >= WINDOW_MARGIN ? Math.min(nx, maxX) : WINDOW_MARGIN
    nx = Math.max(WINDOW_MARGIN, nx)
  }
  if (winH > 0) {
    const maxY = winH - h - WINDOW_MARGIN
    ny = maxY >= WINDOW_MARGIN ? Math.min(ny, maxY) : WINDOW_MARGIN
    ny = Math.max(WINDOW_MARGIN, ny)
  }
  return { x: nx, y: ny }
}

function hidePasswordMenuInternal() {
  pwMenu.style.display = 'none'
  pwMenu.innerHTML = ''
}

function showPasswordMenu({ hostname, credentials, x, y, windowWidth, windowHeight }: PasswordMenuPayload = {}) {
  if (activeOverlay === 'password-save') {
    releaseSaveCard()
    hidePasswordSaveInternal(false)
  }
  if (activeOverlay === 'password-unlock') hidePasswordUnlockInternal(false)
  activeOverlay = 'password-menu'

  const list: PasswordCredential[] = Array.isArray(credentials) ? credentials : []
  pwMenu.innerHTML = ''

  if (list.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hira-password-menu__empty'
    empty.textContent = '此站点尚未保存凭据'
    pwMenu.appendChild(empty)
  } else {
    const title = document.createElement('div')
    title.className = 'hira-password-menu__title'
    title.textContent = hostname || ''
    pwMenu.appendChild(title)

    for (const cred of list) {
      const item = document.createElement('div')
      item.className = 'hira-password-menu__item'
      const un = document.createElement('span')
      un.className = 'hira-password-menu__item-un'
      un.textContent = cred.username || '(未填用户名)'
      item.appendChild(un)
      const fill = document.createElement('span')
      fill.className = 'hira-password-menu__item-fill'
      fill.textContent = passwordPreview(cred.password)
      item.appendChild(fill)
      // mousedown 阻止默认，避免输入框失焦导致页面先收起相关 UI
      item.addEventListener('mousedown', (e) => e.preventDefault())
      item.addEventListener('click', () => {
        try {
          getHiraBridge().provider.invoke(ROUTE_COMMIT, {
            kind: 'menu',
            hostname,
            credential: cred
          })
        } catch {}
        hidePasswordMenu()
      })
      pwMenu.appendChild(item)
    }
  }

  pwMenu.style.left = `${OVERLAY_SIDE_PADDING}px`
  pwMenu.style.top = '0px'
  pwMenu.style.display = 'block'
  const rect = pwMenu.getBoundingClientRect()
  const viewW = Math.ceil(rect.width + OVERLAY_SIDE_PADDING * 2)
  const viewH = Math.ceil(rect.height + OVERLAY_BOTTOM_PADDING)
  const pos = clampIntoWindow(
    Math.round((x || 0) - OVERLAY_SIDE_PADDING),
    Math.round(y || 0),
    viewW,
    viewH,
    typeof windowWidth === 'number' ? windowWidth : 0,
    typeof windowHeight === 'number' ? windowHeight : 0
  )
  setBounds(pos.x, pos.y, viewW, viewH)
  setInteractive(true)
}

function hidePasswordMenu() {
  if (activeOverlay !== 'password-menu') return
  activeOverlay = null
  hidePasswordMenuInternal()
  collapse()
}

// ── DOM：保存密码提示卡 ─────────────────────────────────────
const pwSave = document.createElement('div')
pwSave.className = 'hira-password-save'
root.appendChild(pwSave)
// 事件委托**只注册一次**：卡片内容是每次 show 时重建的（innerHTML），
// 若把监听写在 showPasswordSave 里，每次弹出都会多挂一份 → 一次点击保存多次。
pwSave.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as Element | null
  const btn = target?.closest<HTMLElement>('[data-action]')
  if (!btn) return
  commitSaveAction(btn.dataset.action)
})

function hidePasswordSaveInternal(collapseView = true) {
  pwSave.style.display = 'none'
  pwSave.innerHTML = ''
  currentSavePayload = null
  if (collapseView) collapse()
}

function commitSaveAction(action: string | undefined): void {
  if (!action) return
  const hostname = currentSavePayload ? currentSavePayload.hostname : ''
  const uEl = pwSave.querySelector<HTMLInputElement>('#pw-save-username')
  const pEl = pwSave.querySelector<HTMLInputElement>('#pw-save-password')
  const username = uEl ? uEl.value : (currentSavePayload ? currentSavePayload.username : '')
  const password = pEl ? pEl.value : (currentSavePayload ? currentSavePayload.password : '')
  try {
    getHiraBridge().provider.invoke(ROUTE_COMMIT, {
      kind: 'save',
      action,
      hostname,
      username,
      password
    })
  } catch {}
  hidePasswordSave()
}

function showPasswordSave({
  hostname,
  username,
  password,
  readOnlyBackend,
  windowWidth,
  windowHeight
}: PasswordSavePayload = {}) {
  if (activeOverlay === 'password-menu') hidePasswordMenuInternal()
  if (activeOverlay === 'password-unlock') hidePasswordUnlockInternal(false)
  activeOverlay = 'password-save'
  currentSavePayload = {
    hostname: String(hostname || ''),
    username: String(username || ''),
    password: String(password || '')
  }

  const safe = (s: unknown) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  pwSave.innerHTML = `
    <div class="hira-password-save__title">保存密码？</div>
    <div class="hira-password-save__host">${safe(hostname)}</div>
    ${readOnlyBackend
      ? '<div class="hira-password-save__hint">外部密码库为只读集成，这条密码会保存到内置保险库。</div>'
      : ''}
    <div class="hira-password-save__row">
      <label>用户名</label>
      <input id="pw-save-username" type="text" value="${safe(username)}" />
    </div>
    <div class="hira-password-save__row">
      <label>密码</label>
      <input id="pw-save-password" type="password" value="${safe(password)}" />
      <span class="hira-password-save__reveal" title="显示密码">👁</span>
    </div>
    <div class="hira-password-save__actions">
      <button data-action="never" type="button">永不保存</button>
      <button data-action="later" type="button">暂不保存</button>
      <button data-action="save" type="button">保存</button>
    </div>
  `

  const reveal = pwSave.querySelector('.hira-password-save__reveal')
  if (reveal) {
    reveal.addEventListener('mousedown', (e) => e.preventDefault())
    reveal.addEventListener('click', () => {
      const inp = pwSave.querySelector<HTMLInputElement>('#pw-save-password')
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password'
    })
  }

  // 右上角定位：以**实测**尺寸整体靠右，保证整张卡（含阴影 padding）都在窗口内。
  // 不要再拿常量 320 去算 x —— 实测宽度含 padding+border，两者不一致会溢出右侧。
  pwSave.style.left = `${OVERLAY_SIDE_PADDING}px`
  pwSave.style.top = '0px'
  pwSave.style.display = 'block'
  const rect = pwSave.getBoundingClientRect()
  const viewW = Math.ceil(rect.width + OVERLAY_SIDE_PADDING * 2)
  const viewH = Math.ceil(rect.height + OVERLAY_BOTTOM_PADDING)
  const w = (typeof windowWidth === 'number' && windowWidth > 0) ? windowWidth : (window.innerWidth || 0)
  const h = (typeof windowHeight === 'number' && windowHeight > 0) ? windowHeight : (window.innerHeight || 0)
  const pos = clampIntoWindow(w - viewW - 16, 16, viewW, viewH, w, h)
  setBounds(pos.x, pos.y, viewW, viewH)
  setInteractive(true)
}

function hidePasswordSave() {
  if (activeOverlay !== 'password-save') return
  activeOverlay = null
  hidePasswordSaveInternal(true)
}

// 保存卡被另一张卡（菜单 / 解锁卡）顶掉：主进程只清"正在展示"占位，
// **不记入会话去重** —— 用户还没做决定，之后同一凭据仍应提示。
function releaseSaveCard() {
  if (!currentSavePayload) return
  try {
    getHiraBridge().provider.invoke(ROUTE_COMMIT, { kind: 'save-release' })
  } catch {}
  currentSavePayload = null
}

// 未做选择就关闭（点击空白 / Esc）：回传 save-dismiss，主进程对同凭据做会话去重
function dismissSave() {
  if (activeOverlay !== 'password-save' || !currentSavePayload) {
    hidePasswordSave()
    return
  }
  const p = currentSavePayload
  try {
    getHiraBridge().provider.invoke(ROUTE_COMMIT, {
      kind: 'save-dismiss',
      hostname: p.hostname,
      username: p.username,
      password: p.password
    })
  } catch {}
  hidePasswordSave()
}

// ── DOM：解锁 / 登录卡 ─────────────────────────────────────
// 与保存卡共用视觉，但**字段与文案全部来自后端契约**：
//   stage='unlock'   → 一个主密码框
//   stage='sign-in'  → 按 status.signInFields 动态渲染
// 本页不认识 Bitwarden / 1Password，新增后端零改动。
const pwUnlock = document.createElement('div')
pwUnlock.className = 'hira-password-save hira-password-unlock'
root.appendChild(pwUnlock)

interface UnlockPayload {
  backend?: string
  stage?: string
  message?: string
  displayName?: string
  hostname?: string
  unlockHint?: string
  signInHint?: string
  signInLabel?: string
  signInFields?: SignInField[]
  windowWidth?: number
  windowHeight?: number
  [key: string]: unknown
}

interface SignInField {
  key?: string
  label?: string
  type?: string
  placeholder?: string
}

let currentUnlockPayload: UnlockPayload | null = null
// 已输入内容跨阶段保留（unlock 失败转 sign-in 时不必重敲）
const unlockDraft = new Map<string, string>()

function captureUnlockDraft(): void {
  const inputs = pwUnlock.querySelectorAll<HTMLInputElement>('[data-pw-field]')
  for (const input of inputs) {
    if (input.dataset.pwField) unlockDraft.set(input.dataset.pwField, input.value)
  }
}

function setUnlockBusy(busy: boolean): void {
  const buttons = pwUnlock.querySelectorAll('button')
  for (const btn of buttons) btn.disabled = !!busy
  pwUnlock.classList.toggle('is-busy', !!busy)
}

function renderUnlockCard(payload: UnlockPayload, message: string): void {
  if (!payload) return
  const stage = payload.stage === 'sign-in' ? 'sign-in' : 'unlock'
  const displayName = payload.displayName || payload.backend || '密码库'
  const hostname = payload.hostname || ''
  const hint = stage === 'sign-in' ? (payload.signInHint || '') : (payload.unlockHint || '')
  const primaryLabel = stage === 'sign-in' ? (payload.signInLabel || '登录') : '解锁'
  const fields: SignInField[] = Array.isArray(payload.signInFields) ? payload.signInFields : []
  const safe = (s: unknown) => String(s == null ? '' : s).replace(/"/g, '&quot;')

  let rows = ''
  if (stage === 'sign-in') {
    for (const field of fields) {
      if (!field || !field.key) continue
      const type = field.type === 'password' ? 'password' : 'text'
      const value = safe(unlockDraft.get(field.key) || '')
      const placeholder = field.placeholder ? ` placeholder="${safe(field.placeholder)}"` : ''
      rows += `
        <div class="hira-password-save__row hira-password-unlock__row">
          <label>${safe(field.label || field.key)}</label>
          <input data-pw-field="${safe(field.key)}" type="${type}" value="${value}"${placeholder} spellcheck="false" autocomplete="off" />
        </div>`
    }
  } else {
    const value = safe(unlockDraft.get('password') || '')
    rows = `
      <div class="hira-password-save__row hira-password-unlock__row">
        <label>主密码</label>
        <input data-pw-field="password" type="password" value="${value}" spellcheck="false" autocomplete="off" />
      </div>`
  }

  const subtitle = stage === 'sign-in'
    ? '登录后会自动继续填充。'
    : (hostname || '输入主密码以读取凭据')

  pwUnlock.innerHTML = `
    <div class="hira-password-save__title">${stage === 'sign-in' ? `登录 ${safe(displayName)}` : `解锁 ${safe(displayName)}`}</div>
    <div class="hira-password-save__host">${safe(subtitle)}</div>
    ${hint ? `<div class="hira-password-save__hint">${safe(hint)}</div>` : ''}
    <div class="hira-password-unlock__error">${safe(message)}</div>
    ${rows}
    <div class="hira-password-save__actions hira-password-unlock__actions">
      <button data-pw-action="unlock-cancel" type="button">取消</button>
      <button data-pw-action="${stage}" data-pw-primary="1" type="button">${safe(primaryLabel)}</button>
    </div>
    <span class="hira-password-unlock__switch" data-pw-switch="${stage === 'sign-in' ? 'unlock' : 'sign-in'}">
      ${stage === 'sign-in' ? '改用主密码解锁' : '改用账号登录'}
    </span>
  `
}

function focusUnlockField() {
  const first = pwUnlock.querySelector<HTMLInputElement>('[data-pw-field]')
  if (!first) return
  first.focus()
  if (first.select) first.select()
}

function layoutUnlock(payload: UnlockPayload): void {
  pwUnlock.style.left = `${OVERLAY_SIDE_PADDING}px`
  pwUnlock.style.top = '0px'
  pwUnlock.style.display = 'block'
  const rect = pwUnlock.getBoundingClientRect()
  const viewW = Math.ceil(rect.width + OVERLAY_SIDE_PADDING * 2)
  const viewH = Math.ceil(rect.height + OVERLAY_BOTTOM_PADDING)
  const winW = (typeof payload.windowWidth === 'number' && payload.windowWidth > 0)
    ? payload.windowWidth : (window.innerWidth || 0)
  const winH = (typeof payload.windowHeight === 'number' && payload.windowHeight > 0)
    ? payload.windowHeight : (window.innerHeight || 0)
  // 水平居中、垂直偏上（与浏览器原生密码弹窗体感一致），再整体钳进窗口
  const pos = clampIntoWindow(
    Math.round((winW - viewW) / 2),
    96,
    viewW,
    viewH,
    winW,
    winH
  )
  setBounds(pos.x, pos.y, viewW, viewH)
  setInteractive(true)
}

function hidePasswordUnlockInternal(collapseView = true) {
  pwUnlock.style.display = 'none'
  pwUnlock.innerHTML = ''
  pwUnlock.classList.remove('is-busy')
  currentUnlockPayload = null
  unlockDraft.clear()
  if (collapseView) collapse()
}

function showPasswordUnlock(payload: UnlockPayload) {
  if (!payload) return
  if (activeOverlay === 'password-menu') hidePasswordMenuInternal()
  if (activeOverlay === 'password-save') {
    releaseSaveCard()
    hidePasswordSaveInternal(false)
  }
  // 同一张卡重复推送（错误提示重投 / 阶段切换）时保留已输入值
  if (activeOverlay === 'password-unlock' && currentUnlockPayload) captureUnlockDraft()
  activeOverlay = 'password-unlock'
  currentUnlockPayload = payload
  renderUnlockCard(payload, payload.message || '')
  layoutUnlock(payload)
  setUnlockBusy(false)
  focusUnlockField()
}

function hidePasswordUnlock() {
  if (activeOverlay !== 'password-unlock') return
  activeOverlay = null
  hidePasswordUnlockInternal(true)
}

function commitUnlock(kind: string | undefined): void {
  if (!kind || !currentUnlockPayload) return
  if (kind === 'unlock-cancel') {
    try {
      getHiraBridge().provider.invoke(ROUTE_COMMIT, { kind: 'unlock-cancel' })
    } catch {}
    hidePasswordUnlock()
    return
  }
  captureUnlockDraft()
  const payload: Record<string, unknown> = { kind }
  for (const [key, value] of unlockDraft.entries()) payload[key] = value
  payload.backend = currentUnlockPayload.backend || ''
  setUnlockBusy(true)
  try {
    getHiraBridge().provider.invoke(ROUTE_COMMIT, payload)
  } catch (e) {
    console.error('[pw-overlay] unlock commit failed:', errorMessage(e))
    setUnlockBusy(false)
  }
  // 成功 → 主进程推 hide；失败 → 主进程推带 message 的 show（本卡重绘并恢复可点）
}

// 阶段切换（改用账号登录 / 返回主密码解锁）：不改后端状态，只换表单形态
function switchUnlockStage(nextStage?: string): void {
  if (!currentUnlockPayload) return
  captureUnlockDraft()
  const next = { ...currentUnlockPayload, stage: nextStage === 'sign-in' ? 'sign-in' : 'unlock', message: '' }
  currentUnlockPayload = next
  renderUnlockCard(next, '')
  layoutUnlock(next)
  focusUnlockField()
}

// 事件委托**只注册一次**（卡片内容每次 show 时重建）
pwUnlock.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as Element | null
  const switchEl = target?.closest<HTMLElement>('[data-pw-switch]')
  if (switchEl) {
    // 重绘会让 e.target 脱离 DOM，必须拦截冒泡，否则会被下方「点击空白」判成外部点击
    e.stopPropagation()
    switchUnlockStage(switchEl.dataset.pwSwitch)
    return
  }
  const btn = target?.closest<HTMLButtonElement>('[data-pw-action]')
  if (!btn || btn.disabled) return
  commitUnlock(btn.dataset.pwAction)
})

// ── 点击空白 / Escape 关闭 ──────────────────────────────────
document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as Node | null
  if (activeOverlay === 'password-menu' && !pwMenu.contains(target)) {
    try { getHiraBridge().provider.invoke(ROUTE_COMMIT, { kind: 'menu-cancel' }) } catch {}
    hidePasswordMenu()
  } else if (activeOverlay === 'password-save' && !pwSave.contains(target)) {
    dismissSave()
  } else if (activeOverlay === 'password-unlock' && !pwUnlock.contains(target)) {
    commitUnlock('unlock-cancel')
  }
})
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (activeOverlay === 'password-unlock' && e.key === 'Enter') {
    const primary = pwUnlock.querySelector<HTMLButtonElement>('[data-pw-primary="1"]')
    if (primary && !primary.disabled) {
      e.preventDefault()
      commitUnlock(primary.dataset.pwAction)
    }
    return
  }
  if (e.key !== 'Escape') return
  if (activeOverlay === 'password-menu') {
    try { getHiraBridge().provider.invoke(ROUTE_COMMIT, { kind: 'menu-cancel' }) } catch {}
    hidePasswordMenu()
  } else if (activeOverlay === 'password-save') {
    dismissSave()
  } else if (activeOverlay === 'password-unlock') {
    commitUnlock('unlock-cancel')
  }
})

// ── 独立浮层的 bounds / interactive（专用 IPC，不与通用 overlay 混用）──
function collapse() {
  setBounds(0, 0, 0, 0)
  setInteractive(false)
}

async function setInteractive(interactive: boolean): Promise<void> {
  try {
    await getHiraBridge().provider.invoke(ROUTE_SET_INTERACTIVE, { interactive })
  } catch (e) { console.error('[pw-overlay] set-interactive failed:', errorMessage(e)) }
}

async function setBounds(x: number, y: number, width: number, height: number): Promise<void> {
  try {
    await getHiraBridge().provider.invoke(ROUTE_SET_BOUNDS, { x, y, width, height })
  } catch (e) { console.error('[pw-overlay] set-bounds failed:', errorMessage(e)) }
}

// ── 监听主进程事件 ──────────────────────────────────────────
;(function boot() {
  window.addEventListener('error', (e) => {
    console.error('[pw-overlay] window error:', e.message, '@', e.filename, e.lineno)
  })
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[pw-overlay] unhandled rejection:', e.reason && (e.reason.message || e.reason))
  })
  try {
    const bridge = getHiraBridge()
    bridge.on.subscribe(IPC_EVENTS.overlayShowPasswordMenu, (p) => {
      try { showPasswordMenu((p || {}) as unknown as Parameters<typeof showPasswordMenu>[0]) } catch (err) { console.error('[pw-overlay] show-menu threw:', err) }
    })
    bridge.on.subscribe(IPC_EVENTS.overlayHidePasswordMenu, () => hidePasswordMenu())
    bridge.on.subscribe(IPC_EVENTS.overlayShowPasswordSave, (p) => {
      try { showPasswordSave((p || {}) as unknown as Parameters<typeof showPasswordSave>[0]) } catch (err) { console.error('[pw-overlay] show-save threw:', err) }
    })
    bridge.on.subscribe(IPC_EVENTS.overlayHidePasswordSave, () => hidePasswordSave())
    bridge.on.subscribe(IPC_EVENTS.overlayShowPasswordUnlock, (p) => {
      try { showPasswordUnlock((p || {}) as unknown as UnlockPayload) } catch (err) { console.error('[pw-overlay] show-unlock threw:', errorMessage(err)) }
    })
    bridge.on.subscribe(IPC_EVENTS.overlayHidePasswordUnlock, () => hidePasswordUnlock())
    ;(async () => {
      try { await bridge.provider.invoke(ROUTE_READY, {}) } catch (e) { console.error('[pw-overlay] ready invoke failed:', errorMessage(e)) }
    })()
  } catch (e) {
    console.error('[pw-overlay] boot failed:', errorMessage(e))
  }
})()


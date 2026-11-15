/**
 * 「关于 Hira」页 · 软件更新面板（第二个选项卡）
 *
 * ── 为什么是一个独立模块，而不是塞回 about.js ─────────────────────────
 * 关于页回答的是"我装的是什么"，更新面板回答的是"有没有新的 / 怎么装"——
 * 两块状态机、两套 DOM、两条 IPC 订阅，只有**壳**是同一个（同一个页面的两个选项卡）。
 * 合在一个文件里，任何一边加功能都会把另一边的初始化顺序牵进来。这里按面拆开：
 * 关于 / 更新各自一个模块，about.js 只负责选项卡切换（纯装配，零业务）。
 *
 * ── 状态真源 ────────────────────────────────────────────────────────
 * 状态机只在主进程 `main/update/service.js`。本模块**不推导任何状态**：
 * 启动拉一次 `update:state`，之后由 `update:changed` 推整体快照；
 * 动作（检查 / 下载 / 安装）的 RPC 返回值就是最新快照，直接套用。
 *
 * ── 懒初始化 ────────────────────────────────────────────────────────
 * 选项卡没被点开就不订阅、不发 IPC —— 打开关于页（绝大多数时候只是看版本）
 * 不该顺带唤一次更新服务。`activate()` 首次调用才接线，之后幂等。
 */

import { IPC_ROUTES, IPC_EVENTS, rpc, subscribe, fmtTime, fmtSize } from 'hira://shared/runtime.js'
// 偏好键名 / 通道词表 / 周期护栏的唯一真源（域层默认值与主进程更新服务同源）。
import {
  UPDATE_SETTING_KEYS,
  UPDATE_CHANNELS,
  UPDATE_INTERVAL_LIMITS,
  DEFAULT_UPDATE_SETTINGS
} from 'hira://shared/update-settings.mjs'

/** 状态文案与色调的唯一映射（展示层映射，不参与状态推导）。 */
const STATUS_META: Readonly<Record<string, { label: string; tone: string }>> = Object.freeze({
  unsupported: { label: '不可用', tone: '' },
  idle: { label: '待检查', tone: '' },
  checking: { label: '检查中', tone: 'badge-accent' },
  'up-to-date': { label: '已是最新', tone: 'badge-success' },
  available: { label: '有可用更新', tone: 'badge-accent' },
  downloading: { label: '下载中', tone: 'badge-accent' },
  downloaded: { label: '等待安装', tone: 'badge-success' },
  error: { label: '出错', tone: 'badge-danger' }
})

/**
 * 更新偏好的键名（值的真源仍是 domain-settings，这里只做引用）。
 *
 * 本页是这组偏好**唯一**的编辑处：设置页的「软件更新」大类只是一扇跳转门，
 * 不再重复长一份表单 —— 否则同一组开关会有两套 UI、两处口径。
 */
const PREF_KEYS = UPDATE_SETTING_KEYS

// 输入框护栏：域层与更新服务都会再校验一次，这里只为"用户敲了个离谱值"时
// 就地纠正，让输入框显示的值与真正落库的值始终一致。
const INTERVAL_MIN = UPDATE_INTERVAL_LIMITS.min
const INTERVAL_MAX = UPDATE_INTERVAL_LIMITS.max
const DEFAULT_INTERVAL_HOURS = DEFAULT_UPDATE_SETTINGS[PREF_KEYS.intervalHours]

type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

interface UpdateSnapshot {
  status: string
  supported?: boolean
  lastCheckAt?: number | null
  message?: string
  availableVersion?: string
  currentVersion?: string
  channel?: string
  error?: string
  progress?: number
  total?: number
  transferred?: number
  bytesPerSecond?: number
}

interface UpdatePanelDom {
  badge: HTMLElement
  line: HTMLElement
  progress: HTMLElement
  track: HTMLElement
  fill: HTMLElement
  progressMeta: HTMLElement
  feedback: HTMLElement
  check: HTMLButtonElement
  download: HTMLButtonElement
  install: HTMLButtonElement
  channels: HTMLElement
  channelHint: HTMLElement
  autoCheck: HTMLInputElement
  interval: HTMLInputElement
  intervalHint: HTMLElement
}

function requiredElement<T>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`Update panel element ${selector} is unavailable`)
  return element as unknown as T
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** 通道按钮由共享词表渲染 —— HTML 不手抄通道 id / 中文名，改词表即可。 */
function renderChannelButtons(container: HTMLElement): void {
  container.replaceChildren(...UPDATE_CHANNELS.map((channel: UpdateChannel) => {
    const button = document.createElement('button')
    button.className = 'btn'
    button.type = 'button'
    button.dataset.channel = channel.id
    button.textContent = channel.label
    button.setAttribute('aria-pressed', 'false')
    return button
  }))
}

/** 通道提示文案（通道 id → 一句话解释）。 */
function channelHint(id: string): string {
  const channel = UPDATE_CHANNELS.find((item: UpdateChannel) => item.id === id)
  return channel ? channel.hint : ''
}

/**
 * 创建更新面板控制器。
 * @param {HTMLElement} pane 该选项卡的容器（DOM 已在 index.html 里）
 * @returns {{ activate: () => void }}
 */
export function createUpdatePanel(pane: HTMLElement) : { activate: () => void } {
  const dom: UpdatePanelDom = {
    badge: requiredElement<HTMLElement>(pane, '#status-badge'),
    line: requiredElement<HTMLElement>(pane, '#status-line'),
    progress: requiredElement<HTMLElement>(pane, '#progress'),
    track: requiredElement<HTMLElement>(pane, '#progress-track'),
    fill: requiredElement<HTMLElement>(pane, '#progress-fill'),
    progressMeta: requiredElement<HTMLElement>(pane, '#progress-meta'),
    feedback: requiredElement<HTMLElement>(pane, '#feedback'),
    check: requiredElement<HTMLButtonElement>(pane, '#btn-check'),
    download: requiredElement<HTMLButtonElement>(pane, '#btn-download'),
    install: requiredElement<HTMLButtonElement>(pane, '#btn-install'),
    channels: requiredElement<HTMLElement>(pane, '#channels'),
    channelHint: requiredElement<HTMLElement>(pane, '#channel-hint'),
    autoCheck: requiredElement<HTMLInputElement>(pane, '#auto-check'),
    interval: requiredElement<HTMLInputElement>(pane, '#interval-hours'),
    intervalHint: requiredElement<HTMLElement>(pane, '#interval-hint')
  }
  renderChannelButtons(dom.channels)
  // 周期输入框的护栏与默认值提示都来自共享真源（HTML 不手抄 1 / 8760 / 1440）。
  dom.interval.min = String(INTERVAL_MIN)
  dom.interval.max = String(INTERVAL_MAX)
  dom.intervalHint.textContent =
    `默认 ${DEFAULT_INTERVAL_HOURS} 小时（${Math.round(DEFAULT_INTERVAL_HOURS / 24)} 天）。`

  /** 最近一次快照（主进程推来的整体状态）。 */
  let snapshot: UpdateSnapshot | null = null
  /** 是否有动作在途（防连点；与主进程的 checking/downloading 是两回事）。 */
  let busy = false
  /** 已接线（activate 幂等）。 */
  let wired = false

  function showFeedback(type: string, text: string): void {
    dom.feedback.dataset.type = type
    dom.feedback.textContent = text
    dom.feedback.hidden = false
  }

  function clearFeedback(): void {
    dom.feedback.hidden = true
    dom.feedback.textContent = ''
    delete dom.feedback.dataset.type
  }

  /** 状态行：一句话解释「现在处于什么局面」。 */
  function statusLine(state: UpdateSnapshot): string {
    const last = state.lastCheckAt ? `上次检查：${fmtTime(state.lastCheckAt)}` : '尚未检查过更新。'
    switch (state.status) {
      case 'unsupported':
        return state.message || '当前构建不提供自动更新。'
      case 'checking':
        return '正在向发布通道查询版本信息…'
      case 'up-to-date':
        return state.message || '已是最新版本。'
      case 'available':
        return state.availableVersion
          ? `发现新版本 ${state.availableVersion}（当前 ${state.currentVersion}）。`
          : '发现可用更新。'
      case 'downloading':
        return state.availableVersion ? `正在下载 ${state.availableVersion}…` : '正在下载更新包…'
      case 'downloaded':
        return state.message || `新版本 ${state.availableVersion} 已下载，重启即可安装。`
      case 'error':
        return state.error || state.message || '更新过程出错。'
      default:
        return last
    }
  }

  function renderProgress(state: UpdateSnapshot): void {
    const visible = state.status === 'downloading'
    dom.progress.hidden = !visible
    if (!visible) return
    const percent = Math.max(0, Math.min(100, Number(state.progress) || 0))
    dom.fill.style.width = percent + '%'
    dom.track.setAttribute('aria-valuenow', String(Math.round(percent)))
    const parts = [Math.round(percent) + '%']
    const total = Number(state.total) || 0
    const transferred = Number(state.transferred) || 0
    const bytesPerSecond = Number(state.bytesPerSecond) || 0
    if (total > 0) parts.push(`${fmtSize(transferred)} / ${fmtSize(total)}`)
    else if (transferred > 0) parts.push(fmtSize(transferred))
    if (bytesPerSecond > 0) parts.push(fmtSize(bytesPerSecond) + '/s')
    dom.progressMeta.textContent = parts.join(' · ')
  }

  /** 渲染整面板（快照驱动，幂等）。 */
  function render() {
    if (!snapshot) return
    const state = snapshot

    const meta = STATUS_META[state.status] || STATUS_META.idle
    dom.badge.textContent = meta.label
    dom.badge.className = 'badge' + (meta.tone ? ' ' + meta.tone : '')
    dom.line.textContent = statusLine(state)

    renderProgress(state)

    // 按钮可用性：一律由快照 + 在途标记决定，不允许按钮自己另存一份状态
    const supported = state.supported === true
    const checking = state.status === 'checking'
    const downloading = state.status === 'downloading'
    dom.check.disabled = !supported || busy || checking || downloading
    dom.check.textContent = checking ? '检查中…' : '检查更新'

    dom.download.disabled = !supported || busy || state.status !== 'available'
    dom.download.textContent = downloading ? '下载中…' : '下载更新'

    const installable = state.status === 'downloaded'
    dom.install.disabled = !supported || busy || !installable
    dom.install.className = 'btn' + (installable ? ' btn-primary' : '')

    // 通道切换
    for (const button of dom.channels.querySelectorAll<HTMLButtonElement>('[data-channel]')) {
      const id = button.dataset.channel
      const active = id === state.channel
      button.className = 'btn' + (active ? ' btn-primary' : '')
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
      button.disabled = busy || !supported || downloading
    }
    dom.channelHint.textContent = channelHint(state.channel || '') + ' 切换通道后需要重新检查。'

    syncPrefsEnabled()
  }

  /** 应用快照（事件与 RPC 返回共用同一条路径）。 */
  function applySnapshot(next: unknown): void {
    if (!next || typeof next !== 'object') return
    const record = next as Record<string, unknown>
    if (typeof record.status !== 'string') return
    snapshot = record as unknown as UpdateSnapshot
    render()
  }

  /**
   * 执行一个动作。check / download 的 RPC 返回值就是最新快照，直接套用；
   * install 的返回值是 `{ ok, message }`，只在失败时给提示。
   */
  async function runAction(kind: 'check' | 'download' | 'install'): Promise<void> {
    if (busy || !snapshot) return
    busy = true
    clearFeedback()
    render()
    try {
      if (kind === 'install') {
        const result = await rpc(IPC_ROUTES.updateInstall, {})
        if (!result || result.ok !== true) {
          showFeedback('error', String((result && result.message) || '安装未能启动。'))
        }
      } else {
        const route = kind === 'check' ? IPC_ROUTES.updateCheck : IPC_ROUTES.updateDownload
        applySnapshot(await rpc(route, {}))
      }
    } catch (error) {
      showFeedback('error', '操作失败：' + errorText(error, String(error)))
    } finally {
      busy = false
      render()
    }
  }

  /** 切换通道：写设置，服务会自行作废旧结论并广播新快照。 */
  async function setChannel(id: string): Promise<void> {
    if (busy || !snapshot || snapshot.channel === id) return
    busy = true
    clearFeedback()
    render()
    try {
      await rpc(IPC_ROUTES.settingsSet, { key: PREF_KEYS.channel, value: id })
    } catch (error) {
      showFeedback('error', '切换通道失败：' + errorText(error, String(error)))
    } finally {
      busy = false
      render()
    }
  }

  /** 把任意输入收敛成合法的周期小时数（整数，1..8760）。 */
  function normalizeInterval(raw: unknown): number {
    const value = Math.round(Number(raw))
    if (!Number.isFinite(value)) return DEFAULT_INTERVAL_HOURS
    return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, value))
  }

  /**
   * 偏好控件的可用性：构建不支持更新时整组停用；
   * 周期只在自动检查开启时才有意义，两者一起看才不误导。
   */
  function syncPrefsEnabled(): void {
    const supported = !snapshot || snapshot.supported === true
    dom.autoCheck.disabled = !supported
    dom.interval.disabled = !supported || !dom.autoCheck.checked
  }

  /** 读一组偏好，填充本页控件（域层已有默认值，读不到才用本地兜底）。 */
  async function loadPrefs(): Promise<void> {
    try {
      const [autoCheck, interval] = await Promise.all([
        rpc(IPC_ROUTES.settingsGet, { key: PREF_KEYS.autoCheck }),
        rpc(IPC_ROUTES.settingsGet, { key: PREF_KEYS.intervalHours })
      ])
      dom.autoCheck.checked = (autoCheck && autoCheck.value) === true
      dom.interval.value = String(normalizeInterval(interval && interval.value))
      syncPrefsEnabled()
    } catch (error) {
      showFeedback('error', '读取更新偏好失败：' + errorText(error, String(error)))
    }
  }

  /**
   * 写一条偏好。服务订阅了设置变更，会自行重排检查计划 —— 本页不需要再通知它，
   * 更不需要自己记一份"下次什么时候检查"。
   */
  async function writePref(key: string, value: unknown, failureText: string): Promise<void> {
    try {
      await rpc(IPC_ROUTES.settingsSet, { key, value })
    } catch (error) {
      showFeedback('error', failureText + '：' + errorText(error, String(error)))
    }
  }

  dom.check.addEventListener('click', () => runAction('check'))
  dom.download.addEventListener('click', () => runAction('download'))
  dom.install.addEventListener('click', () => runAction('install'))
  dom.channels.addEventListener('click', (event) => {
    const target = event.target
    const button = target instanceof Element ? target.closest<HTMLElement>('[data-channel]') : null
    if (button?.dataset.channel) setChannel(button.dataset.channel)
  })
  dom.autoCheck.addEventListener('change', () => {
    syncPrefsEnabled()
    writePref(PREF_KEYS.autoCheck, dom.autoCheck.checked, '保存自动检查设置失败')
  })
  dom.interval.addEventListener('change', () => {
    const value = normalizeInterval(dom.interval.value)
    dom.interval.value = String(value)
    writePref(PREF_KEYS.intervalHours, value, '保存检查周期失败')
  })

  async function boot() {
    try {
      applySnapshot(await rpc(IPC_ROUTES.updateState, {}))
    } catch (error) {
      dom.line.textContent = '读取更新状态失败：' + errorText(error, String(error))
    }
  }

  return {
    activate() {
      if (wired) return
      wired = true
      // 订阅随页面一起存活：页面（= 那个标签）被销毁时渲染进程会一并回收监听，
      // 因此这里不需要再维护一份"退订"状态（少一个 dispose 就少一条会漏调的路径）。
      subscribe(IPC_EVENTS.updateChanged, applySnapshot)
      boot()
      loadPrefs()
    }
  }
}

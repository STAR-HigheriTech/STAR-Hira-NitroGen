// 默认键位 / 分组的**唯一真源**在 shared-types —— 内部页 `hira://shortcuts`
// 读的是同一份文件（构建期复制成 hira://shared/keybindings.mjs）。
// 这里保留 DEFAULT_KEYBINDINGS 这个既有导出名，IPC / 测试 / 调用方无需改动。
import type { Input, WebContents } from 'electron'
import {
  KEYBINDING_DEFAULTS,
  MODIFIER_ORDER,
  EVENT_CODE_KEYS,
  normalizeKeyName,
  comboFromParts
} from '@hira-ng/shared-types/src/keybindings.mjs'

interface ShortcutActionPort { [action: string]: () => unknown }
interface SettingsPort {
  get(key: string): unknown
  set?(key: string, value: unknown): unknown
  subscribe?(listener: (change: { key?: string; value?: unknown } | null | undefined) => void): unknown
  on?(event: 'change', listener: (key: string, value: unknown) => void): unknown
}
interface SlotPort {
  multi(name: string, payload: unknown, context: unknown): unknown
}
interface KeybindingsManagerOptions {
  actions?: ShortcutActionPort
  settingsService?: SettingsPort | null
  slots?: SlotPort | null
}
interface InputEventPort { preventDefault(): void }

export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string>> = KEYBINDING_DEFAULTS as Record<string, string>

const PUNCTUATION_KEYS = new Set<string>(Object.values(EVENT_CODE_KEYS))
const VALID_NAMED_KEYS = new Set<string>([
  'Tab', 'Enter', 'Esc', 'Backspace', 'Delete', 'Space',
  'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'
])

export function normalizeCombo(combo: unknown): string {
  if (typeof combo !== 'string') throw new Error('Shortcut must be a string')
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('Shortcut cannot be empty')

  const modifiers = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    const modifier = lower === 'ctrl' || lower === 'control'
      ? 'Ctrl'
      : lower === 'shift'
        ? 'Shift'
        : lower === 'alt' || lower === 'option'
          ? 'Alt'
          : lower === 'meta' || lower === 'cmd' || lower === 'command'
            ? 'Meta'
            : null
    if (modifier) {
      if (modifiers.has(modifier)) throw new Error(`Duplicate shortcut modifier: ${modifier}`)
      modifiers.add(modifier)
      continue
    }
    if (key) throw new Error('Shortcut must contain exactly one key')
    key = String(normalizeKeyName(part))
  }

  if (!key || (!VALID_NAMED_KEYS.has(key) && !PUNCTUATION_KEYS.has(key) && !/^F(?:[1-9]|1[0-2])$/.test(key) && !/^[A-Z0-9]$/.test(key))) {
    throw new Error(`Unsupported shortcut key: ${key || ''}`)
  }
  if (modifiers.size === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) {
    throw new Error('Shortcut requires a modifier key')
  }

  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+')
}

/**
 * `before-input-event` 的载荷 → 组合串。
 *
 * 归一规则（修饰键顺序、标点按物理键、key 为空的逐级退避）与内部页 `hira://shortcuts`
 * 的录制器**同一份实现** —— 见 shared-types#comboFromParts。这里只做字段名适配
 * （Electron 用 `control`，DOM 用 `ctrlKey`）。
 */
export function eventToCombo(event: Input): string {
  return comboFromParts({
    ctrl: event.control,
    shift: event.shift,
    alt: event.alt,
    meta: event.meta,
    key: event.key,
    code: event.code,
    keyCode: (event as Input & { keyCode?: number }).keyCode
  })
}

/**
 * @param {object} opts
 * @param {object} [opts.actions] 内置动作表（action → handler）
 * @param {object} [opts.settingsService]
 * @param {object} [opts.slots] 宿主侧插槽调用器（`slot-call.js`）——
 *   用于 `shortcut.binding`：插件注册自己的快捷键。缺省表示没有插件参与。
 */
export function createKeybindingsManager({ actions = {}, settingsService = null, slots = null }: KeybindingsManagerOptions = {}) {
  let keybindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS }
  const attached = new Set<WebContents>()

  function load(custom: unknown): void {
    if (!custom || typeof custom !== 'object') return
    for (const [action, combo] of Object.entries(custom)) {
      if (!Object.hasOwn(DEFAULT_KEYBINDINGS, action)) continue
      try {
        keybindings[action] = normalizeCombo(combo)
      } catch (_) {}
    }
  }

  try {
    load(settingsService && typeof settingsService.get === 'function'
      ? settingsService.get('keybindings')
      : null)
  } catch (_) {}

  function buildComboMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [action, combo] of Object.entries(keybindings)) {
      const existing = map.get(combo)
      if (existing && existing !== action) continue
      map.set(combo, action)
    }
    return map
  }

  let comboMap = buildComboMap()

  function persist(): void {
    if (settingsService && typeof settingsService.set === 'function') {
      settingsService.set('keybindings', { ...keybindings })
    }
  }

  /**
   * 问插件要一次按键处理（`shortcut.binding`，MULTI）。
   *
   * 实现形态：`(payload, ctx) => ({ run }) | null`，`payload` 是这次按键的组合串
   * （如 `'Ctrl+Shift+Y'`），不匹配就返回 null。宿主取第一个给出 `run` 的。
   *
   * ⚠ **为什么每次都真调一次插槽，而不是把插件快捷键预先合并进 `comboMap`：**
   * 合并进 map 需要一个"插件启停时重建 map"的失效链路 —— 漏掉一处的表现是
   * "禁用插件后它的快捷键仍然生效"（幽灵快捷键），而那种 bug 极难归因。
   * 现在的做法把正确性建立在**每次现问**上：插件被禁用 → 实现被摘 → 下一次按键自然问不到人。
   * 代价是"未命中内置绑定"的按键会走一次插槽调用；无插件参与时这是
   * `emptyResult`（一次 Map 查找 + 长度判断），可以忽略。
   */
  function handlePluginShortcut(event: InputEventPort, combo: string): boolean {
    if (!slots || typeof slots.multi !== 'function') return false
    const extra = slots.multi('shortcut.binding', combo, { combo })
    const candidates = Array.isArray(extra) ? extra as Array<Record<string, unknown> | null> : []
    const hit = candidates.find((candidate): candidate is Record<string, unknown> & { run(payload: { combo: string }): unknown } => Boolean(candidate && typeof candidate.run === 'function'))
    if (!hit) return false
    event.preventDefault()
    try {
      Promise.resolve(hit.run({ combo })).catch(() => {})
    } catch (_) {}
    return true
  }

  // ── 录制让位（快捷键页专用）───────────────────────────────────────────
  // 快捷键页是普通标签页，它的 webContents 同样挂在 attach 上 —— 录制期间必须
  // 暂停内置分发，否则 Ctrl+T / Ctrl+W 这类键在到达页面之前就被主进程吃掉了。
  // 复位兜底绑在**发起录制的那个 webContents** 上（销毁 / 主框架导航自动解除）：
  // 页面崩了或被用户直接关掉，也不会留下"全局快捷键永久失灵"的幽灵状态。
  let recording = false
  let recordingWc: WebContents | null = null
  let recordingCleanups: Array<() => void> = []

  function stopRecording(): void {
    recording = false
    recordingWc = null
    const pending = recordingCleanups
    recordingCleanups = []
    for (const undo of pending) {
      try { undo() } catch (_) {}
    }
  }

  function setRecording(value: unknown, webContents: WebContents | null | undefined): boolean {
    if (!value || !webContents) {
      stopRecording()
      return false
    }
    if (recording && recordingWc === webContents) return true
    stopRecording()
    recording = true
    recordingWc = webContents
    const release = () => stopRecording()
    try {
      webContents.once('destroyed', release)
      webContents.once('did-navigate', release)
      recordingCleanups.push(() => {
        webContents.removeListener('destroyed', release)
        webContents.removeListener('did-navigate', release)
      })
    } catch (_) {
      // 已经销毁的 wc 挂不上监听：立刻复位，别把全局快捷键锁死
      stopRecording()
    }
    return true
  }

  function handleInputEvent(event: InputEventPort, input: Input): boolean {
    // 内置动作表只处理 keyDown：keyUp 一律返回 false，绝不 preventDefault。
    if (input.type !== 'keyDown') return false
    // 快捷键页正在录制：**整条分发让位**，把按键原样交给页面。
    // 若这里照常 preventDefault，用户按 Ctrl+T 只会新开一个标签页，页面永远收不到该键。
    if (recording) return false
    const combo = eventToCombo(input)
    const action = comboMap.get(combo)
    const handler = action && actions && actions[action]
    if (typeof handler !== 'function') {
      // 内置没命中 → 交给插件（顺序刻意如此：内置绑定永远优先，插件抢不走 Ctrl+T 这类）
      return handlePluginShortcut(event, combo)
    }
    event.preventDefault()
    try {
      Promise.resolve(handler()).catch(() => {})
    } catch (_) {}
    return true
  }

  function attach(webContents: WebContents | null | undefined): void {
    if (!webContents || attached.has(webContents)) return
    webContents.on('before-input-event', handleInputEvent)
    attached.add(webContents)
    /**
     * **销毁即出表**（自清理，不依赖任何调用方）。
     *
     * `attached` 是**管理器级单例**（`module-bootstrap` 只建一份）里的**强引用**集合，
     * 而注册者是各窗口（外壳 + 每个标签）。窗口关掉 / 标签销毁时，全仓**没有任何地方**
     * 回头调 `detach`（它至今零调用点）—— 于是这个集合会随「开过又关的窗口 × 标签」
     * 无界增长，并强持已销毁的 webContents 包装对象，连它的可达对象图都回收不掉。
     *
     * 键控监听本来就挂在本 wc 自己身上（随销毁自然消失），所以这里只需让**集合跟着
     * wc 走**。不用 `detach()` 是因为它会对已销毁的 wc 调 `removeListener`；
     * 直接出表更贴合"对象都没了"的事实。`detach` 保留给将来"显式停用"的用法。
     */
    try {
      webContents.once('destroyed', () => attached.delete(webContents))
    } catch (_) {}
  }

  function detach(webContents: WebContents | null | undefined): void {
    if (!webContents || !attached.has(webContents)) return
    webContents.removeListener('before-input-event', handleInputEvent)
    attached.delete(webContents)
  }

  function getKeybindings(): Record<string, string> {
    return { ...keybindings }
  }

  function getDefaults(): Record<string, string> {
    return { ...DEFAULT_KEYBINDINGS }
  }

  function setKeybinding(action: string, combo: unknown): string {
    if (!Object.hasOwn(DEFAULT_KEYBINDINGS, action)) throw new Error(`Unknown shortcut action: ${action}`)
    const normalized = normalizeCombo(combo)
    const conflict = Object.entries(keybindings).find(([candidate, value]) => candidate !== action && value === normalized)
    if (conflict) throw new Error(`Shortcut already belongs to: ${conflict[0]}`)
    keybindings[action] = normalized
    comboMap = buildComboMap()
    persist()
    return normalized
  }

  function resetKeybinding(action: string): string | undefined {
    if (!Object.hasOwn(DEFAULT_KEYBINDINGS, action)) throw new Error(`Unknown shortcut action: ${action}`)
    keybindings[action] = DEFAULT_KEYBINDINGS[action]
    const conflict = Object.entries(keybindings).find(([candidate, value]) => candidate !== action && value === keybindings[action])
    if (conflict) throw new Error(`Default shortcut conflicts with: ${conflict[0]}`)
    comboMap = buildComboMap()
    persist()
    return keybindings[action]
  }

  function reset(): void {
    keybindings = { ...DEFAULT_KEYBINDINGS }
    comboMap = buildComboMap()
    persist()
  }

  if (settingsService && typeof settingsService.subscribe === 'function') {
    settingsService.subscribe((change) => {
      if (!change || change.key !== 'keybindings') return
      keybindings = { ...DEFAULT_KEYBINDINGS }
      load(change.value)
      comboMap = buildComboMap()
    })
  } else if (settingsService && typeof settingsService.on === 'function') {
    settingsService.on('change', (key, value) => {
      if (key !== 'keybindings') return
      keybindings = { ...DEFAULT_KEYBINDINGS }
      load(value)
      comboMap = buildComboMap()
    })
  }

  return {
    attach,
    detach,
    getKeybindings,
    getDefaults,
    setKeybinding,
    resetKeybinding,
    reset,
    setRecording,
    handleInputEvent
  }
}


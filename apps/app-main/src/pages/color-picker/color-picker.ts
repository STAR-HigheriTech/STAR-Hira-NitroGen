import { el, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, requiredById } from 'hira://shared/page-kit.js'

/** 拿不到主题 accent 时的出厂值（JSON/HTML 的静态默认也用它）。 */
const DEFAULT_COLOR = '#2563eb'

// 跟随 app.theme 三态（浅/深/系统）；await 后 `--hira-accent` 才是主题真值
const themeReady = initTheme()

/** 最近使用色的本地存储键（仅本机、仅本页使用，不上报）。 */
const STORAGE_KEY = 'hira.color-picker.recent'
const MAX_RECENT = 12
const HEX_RE = /^#?([0-9a-f]{6})$/i

const nativeInput = requiredById<HTMLInputElement>('native')
const hexInput = requiredById<HTMLInputElement>('hex')
const rgbOut = requiredById<HTMLElement>('rgb')
const copyHexBtn = requiredById<HTMLButtonElement>('copy-hex')
const copyRgbBtn = requiredById<HTMLButtonElement>('copy-rgb')
const eyedropperBtn = requiredById<HTMLButtonElement>('eyedropper')
const statusEl = requiredById<HTMLElement>('status')
const recentHost = requiredById<HTMLElement>('recent')

let current = DEFAULT_COLOR

/** 任意输入 → 规范化 #rrggbb；格式不合法返回 null。 */
function normalizeHex (value: unknown): string | null {
  const match = HEX_RE.exec(String(value || '').trim())
  return match ? '#' + match[1].toLowerCase() : null
}

function toRgb (hex: string): { r: number; g: number; b: number } | null {
  const match = HEX_RE.exec(hex)
  if (!match) return null
  const int = parseInt(match[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

function rgbString (hex: string): string {
  const rgb = toRgb(hex)
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : ''
}

function setStatus (text: string, isError = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('picker-status--error', isError)
}

/* ── 最近使用色（localStorage，去重，最多 12 个） ───────────────────────── */

function readRecent (): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of list) {
      const hex = normalizeHex(item)
      if (hex && !seen.has(hex)) {
        seen.add(hex)
        result.push(hex)
      }
    }
    return result.slice(0, MAX_RECENT)
  } catch (_) {
    return []
  }
}

function writeRecent (list: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (_) {
    // 存储不可用（隐私模式 / 配额）时静默降级：最近使用色只是便利功能
  }
}

function remember (hex: string): void {
  const list = readRecent().filter((item: string) => item !== hex)
  list.unshift(hex)
  writeRecent(list.slice(0, MAX_RECENT))
  renderRecent()
}

function renderRecent (): void {
  const list = readRecent()
  recentHost.textContent = ''
  if (list.length === 0) {
    recentHost.appendChild(el('span', 'picker-empty', '还没有使用记录，选一个颜色后会出现在这里。'))
    return
  }
  for (const hex of list) {
    const swatch = el('button', 'picker-swatch')
    swatch.type = 'button'
    swatch.title = hex
    swatch.style.background = hex
    swatch.addEventListener('click', () => {
      apply(hex, { record: true })
      setStatus(`已应用最近使用色：${hex}`)
    })
    recentHost.appendChild(swatch)
  }
}

/* ── 颜色应用（原生选择器 / 十六进制输入 / 屏幕取色 共用同一个落点） ─────── */

function apply (hex: unknown, { record = false }: { record?: boolean } = {}): boolean {
  const normalized = normalizeHex(hex)
  if (!normalized) return false
  current = normalized
  nativeInput.value = normalized
  if (hexInput.value !== normalized) hexInput.value = normalized
  rgbOut.textContent = rgbString(normalized)
  if (record) remember(normalized)
  return true
}

/* ── 复制到剪贴板 ───────────────────────────────────────────────────────── */

async function copy (text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    setStatus(`已复制${label}：${text}`)
  } catch (error) {
    setStatus(`复制失败：${errorMessage(error)}`, true)
  }
}

/* ── 事件绑定 ───────────────────────────────────────────────────────────── */

nativeInput.addEventListener('input', () => {
  apply(nativeInput.value, { record: false })
})
nativeInput.addEventListener('change', () => {
  apply(nativeInput.value, { record: true })
  setStatus(`当前颜色：${current}`)
})

hexInput.addEventListener('input', () => {
  const normalized = normalizeHex(hexInput.value)
  if (normalized) {
    apply(normalized, { record: false })
    setStatus('')
  }
})
hexInput.addEventListener('change', () => {
  if (apply(hexInput.value, { record: true })) {
    setStatus(`当前颜色：${current}`)
  } else {
    // 非法输入：回退到当前真实颜色，并说明原因（不静默吞掉）
    hexInput.value = current
    setStatus('十六进制格式无效，请输入 #RRGGBB。', true)
  }
})

copyHexBtn.addEventListener('click', () => copy(current, 'HEX'))
copyRgbBtn.addEventListener('click', () => copy(rgbString(current), 'RGB'))

// 屏幕取色：仅在运行时确实提供 EyeDropper API 时才显示按钮 ——
// 不支持时保持隐藏，而不是摆一个点了没反应的按钮。
const EyeDropperCtor = (window as Window & { EyeDropper?: new () => EyeDropper }).EyeDropper
if (typeof EyeDropperCtor === 'function') {
  eyedropperBtn.hidden = false
  eyedropperBtn.addEventListener('click', async () => {
    try {
      const result = await new EyeDropperCtor().open()
      apply(result.sRGBHex, { record: true })
      setStatus(`已从屏幕取色：${current}`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('已取消屏幕取色。')
      } else {
        setStatus(`屏幕取色失败：${errorMessage(error)}`, true)
      }
    }
  })
}

/** 用当前主题的强调色播种（只影响本页初始值，不写回主题）。 */
function seedFromTheme (): void {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--hira-accent')
  const accent = normalizeHex(raw)
  if (accent && accent !== current) {
    apply(accent, { record: false })
    setStatus(`当前颜色：${current}`)
  }
}

apply(current, { record: false })
renderRecent()
setStatus(`当前颜色：${current}`)
themeReady.then(seedFromTheme)

/**
 * 组件卡片的**通用外观设置**（默认每个组件都有，不需要各自声明）。
 *
 * 为什么归板层、而不是让 defs/* 各自声明：
 *   底色与字体是**卡片**的属性，不是组件内容的属性 —— defs/* 只画自己那块内容，
 *   卡片是板层画的。所以这几个调节由板层统一注入 schema、统一落成卡片上的 CSS 变量：
 *   组件一个字都不用改，也不知道有这回事。
 *
 * ── 但"每个组件都一样"是**默认**，不是铁律 ──────────────────────────────
 * 同一件事的**合适范围**本来就随组件不同：普通卡片（新闻 / 搜索…）装的是正文，
 * 底色透到 35% 以下文字就读不清了，所以**下限锁在 35%**（范围 35–100）；
 * 而时间 / 日期是"一串大字浮在壁纸上"——它不需要底座，底色**默认 0%**
 * （整块底完全不见，只有字），想铺实底也能一路调到 100%。
 * 两个方向刚好相反，所以范围必须按组件声明。
 *
 * 于是组件可以在自己的 def 里声明 `appearance` **改档**：
 *
 *   appearance: {
 *     bgOpacity: { min: 0, max: 100, default: 0, staleDefault: 100 },
 *     omit: ['bgBlur']          // 整项不要
 *   }
 *
 * 只能改范围 / 默认值 / 标签，**不能新增字段** —— 字段清单只有这里一处真源，
 * 于是"多一个通用外观"仍是改这一个文件，而不是满项目找哪里又加了一条规则。
 *
 * `staleDefault` 是**改默认值时老数据怎么跟上**的那一条：老实例的配置里存着
 * 旧默认值（本项目的 configs 在实例创建时就把 schema 的全部默认值落库了），
 * 不处理的话新默认只对新实例生效 —— 用户的既有卡片纹丝不动，观感就是"改了没反应"。
 * 声明 `staleDefault` 后，存着那个旧值的实例会被当作"从没动过"，直接吃新默认值；
 * 用户真手动设过的其它值一律原样保留。
 *
 * 注入点只有一个：`registry.js#defineWidget`（调用 `appearanceOf(def)`）。
 */

import type { WidgetConfig, WidgetDefinition, WidgetSetting } from './types.js'

/** 默认档（组件没声明 `appearance` 时就是这一套）。 */
export const APPEARANCE_SETTINGS: ReadonlyArray<WidgetSetting> = Object.freeze([
  {
    key: 'bgOpacity',
    label: '底色不透明度',
    type: 'range',
    // 默认档 = **普通卡片**：装的是正文，底色透到 35% 以下就读不清了 ⇒ 下限锁 35%。
    // 大字组件（时间 / 日期）在各自的 def 里把下限放开到 0、默认 0（见 clock.js）。
    min: 35,
    max: 100,
    step: 5,
    unit: '%',
    default: 100,
    // 叫"不透明度"而不是"透明度"：默认值 100 必须是"完全不透"，
    // 若叫透明度，100% 会被读成"完全透明"，正好相反。
    hint: '100% = 完全不透；调低可透出壁纸或页面底色'
  },
  {
    key: 'bgBlur',
    label: '背景模糊',
    type: 'range',
    min: 0,
    max: 40,
    step: 1,
    unit: 'px',
    default: 16,
    // 独立的模糊滑块：只作用于卡片的 backdrop-filter，与底色不透明度互不干扰，
    // 所以"想要毛玻璃但不想太透"和"想要很透但不想糊"是两个各管各的旋钮。
    // 仅在卡片背后有东西（有壁纸、或底色不透明度 < 100%）时才看得见效果。
    hint: '仅当卡片半透明 / 有壁纸时可见；越大玻璃感越强'
  },
  {
    key: 'fg',
    label: '字体颜色',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: '跟随主题' },
      { value: 'light', label: '白色' },
      { value: 'dark', label: '黑色' }
    ]
  }
])

/**
 * 某组件最终生效的外观 schema：默认档 + 该组件的收窄声明。
 */
export function appearanceOf(def?: Pick<WidgetDefinition, 'appearance'> | null): WidgetSetting[] {
  const over = def?.appearance || {}
  const omit = Array.isArray(over.omit) ? over.omit : []
  const out: WidgetSetting[] = []
  for (const s of APPEARANCE_SETTINGS) {
    if (omit.includes(s.key)) continue
    const patch = over[s.key]
    out.push(patch && typeof patch === 'object' ? { ...s, ...(patch as Partial<WidgetSetting>) } : { ...s })
  }
  return out
}

/** 某组件的外观字段名（registry 用它挡住组件自己声明同名键 —— 那样会互相覆盖）。 */
export function appearanceKeysOf(def?: Pick<WidgetDefinition, 'appearance'> | null): string[] {
  return appearanceOf(def).map((s) => s.key)
}

/**
 * 把外观配置落到卡片元素上。
 *
 * 全部是**改 CSS 变量 / data 属性**，而不是给卡片写死样式 ——
 * 于是"调一下透明度"不需要为每种模式、每个组件各写一条规则：
 *   · 不透明度 → `--wgt-bg-alpha`，卡片的底色规则拿它算 alpha（见 newtab.css §1）
 *   · 模糊     → `--wgt-blur`，卡片的 backdrop-filter 拿它算
 *   · 字体     → `data-fg`，在卡片上重写 `--ntp-text` / `--ntp-text-soft`，
 *               卡内所有组件自然跟着变（组件内部本来就只用令牌，没有写死的颜色）
 *
 * 夹取一律按**该组件自己的档**（appearanceOf）—— 与设置面板上看到的范围同源，
 * 所以"面板里能拉到多少"与"实际生效多少"永远一致，老数据超出新范围也会被收进来。
 *
 */
export function applyAppearance(
  el: HTMLElement,
  cfg: WidgetConfig,
  def: Pick<WidgetDefinition, 'appearance'> | null = null
): void {
  const schema = appearanceOf(def)
  const spec = (key: string): WidgetSetting | null => schema.find((item) => item.key === key) || null

  const num = (key: string): number | null => {
    const s = spec(key)
    if (!s) return null
    const value = Number(cfg[key])
    const min = typeof s.min === 'number' ? s.min : 0
    const max = typeof s.max === 'number' ? s.max : 100
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null
  }

  const alpha = num('bgOpacity')
  if (alpha !== null) el.style.setProperty('--wgt-bg-alpha', String(alpha / 100))

  const blur = num('bgBlur')
  if (blur !== null) el.style.setProperty('--wgt-blur', blur + 'px')

  const fg = spec('fg') && (cfg.fg === 'light' || cfg.fg === 'dark') ? cfg.fg : ''
  if (fg) el.dataset.fg = fg
  else delete el.dataset.fg
}

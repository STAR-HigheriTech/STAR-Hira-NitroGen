/**
 * @hira-ng/ui-common / textColor —— 「这坨底色该配黑字还是白字」的判定。
 *
 * **移植自 Hira `ext/textColor/textColor.js`**（那是用 http://harthur.github.io/brain/
 * 训练出来的一个微型神经网络），权重逐位照抄，不做任何"现代化改写" ——
 * 因为它的取舍恰恰是数值规则做不出来的：
 *
 *   · 只看 WCAG 对比度会翻车：bilibili 粉 `#FB7299` 对黑字 8:1 / 对白字 2.6:1，
 *     数值上黑字赢，但压在粉色块上是一团灰扑扑的字；bilibili 蓝 `#00A1D6`、
 *     Spotify 绿 `#1DB954`、橙 `#FF8C00` 全是同一个毛病 —— 中深饱和色一律压白字才好看。
 *   · 但「饱和色就压白字」这种粗规则又会把浅青 `#00BCD4`、浅蓝 `#7EC8E3`
 *     一起带走，那些底色压白字是真的看不清 —— Hira 的判定对它们给黑字。
 *   · 它对中灰 `#A0A0A0` 给白字（对比度数值上黑字更优）—— 这是训练结果的口味，
 *     一并保留：单看某个色会显得"不合理"，但整体观感就是 Hira 那一套。
 *
 * 输入是**归一化到 0~1** 的 rgb —— 与 Hira 的 `bgColor[i] / 255` 一致；
 * 输出 black > 0.5 判黑字，否则白字（阈值同 Hira）。
 *
 * 网络结构（3 → 3 → 1，全部 sigmoid）：
 *   每个隐层节点 h = σ(bias + w·input)，输出 black = σ(bias + Σ W·h)。
 */

export interface NormRGB {
  r: number
  g: number
  b: number
}

/** 隐层 w0：r/g/b 三个权重 + bias */
const H0 = { bias: 14.176907520571566, r: -3.2764240497480652, g: -16.90247884718719, b: -2.9976364179397814 }
/** 隐层 w1 */
const H1 = { bias: 9.086071102351246, r: -4.327474143397604, g: -15.780660155750773, b: 2.879230202567851 }
/** 隐层 w2 */
const H2 = { bias: 22.274487339773476, r: -3.5830205067960965, g: -25.498384261673618, b: -6.998329189107962 }
/** 输出层（只算「黑字」这一路，白字即其补） */
const OUT = { bias: 17.873962570788997, w0: -15.542217788633987, w1: -13.377152708685674, w2: -24.52215186113144 }

/** sigmoid —— 与 Hira 的 `1 / (1 + Math.exp(-sum))` 完全一致 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function hiraVerdict(rgb: number[]): string {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const blackLikelihood = sigmoid(
    OUT.bias +
      OUT.w0 * sigmoid(H0.bias + H0.r * r + H0.g * g + H0.b * b) +
      OUT.w1 * sigmoid(H1.bias + H1.r * r + H1.g * g + H1.b * b) +
      OUT.w2 * sigmoid(H2.bias + H2.r * r + H2.g * g + H2.b * b)
  )
  return blackLikelihood > 0.5 ? '#0b0c0e' : '#ffffff'
}

/** 视为「有彩色（品牌色）」的最小色度（max−min，0~255）：低于它按灰处理，仍走 Hira 的 NN */
const BRAND_CHROMA_MIN = 64
/**
 * 品牌色走白字的亮度上界（WCAG 相对亮度）。
 * 取 0.45：刚好卡在「中深色」与「浅彩色」之间。
 */
const BRAND_WHITE_MAX_L = 0.45

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/**
 * 判定文字色。
 *
 * **底座是 Hira 的神经网络判定**（见上，逐位照抄、未改动），只在其之上补一条
 * 「饱和中深色压白字」的放宽：
 *
 * Hira 的 NN 训练目标是「对比度更高的那个」，于是对**饱和的中深色**一律给黑字 ——
 * 实测它给黑字的包括：B 站高亮蓝 `#23ADE5`（black=0.59）、初音青 `#39C5BB`（black=1.00）、
 * 青 `#00BCD4`（black=0.99）。这类色块上黑字数值对比度确实更高，但视觉上灰扑扑的，
 * 品牌色块压白字才自然 —— 这正是需要放宽的那一段。
 *
 * 放宽的边界卡在**色度 ≥ 64 且 WCAG 相对亮度 < 0.45**：
 *   · 灰（色度 0~63）不走这条路 —— 中灰 `#A0A0A0` 白字只有 2.6:1，必须留给 NN 判；
 *   · 亮色/浅彩不越界：黄 `#FFD700`(L=.70)、亮青 `#00FAF0`(L=.79)、浅蓝 `#7EC8E3`(L=.51)、
 *     浅粉 `#FFB6C1`(L=.59) 都在 0.45 之上 → 仍然黑字，不会糊成一片。
 *
 */
export function pickTextColor(rgb: number[]): string {
  const [r, g, b] = rgb
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  if (chroma >= BRAND_CHROMA_MIN && relativeLuminance(r, g, b) < BRAND_WHITE_MAX_L) return '#ffffff'
  return hiraVerdict(rgb)
}

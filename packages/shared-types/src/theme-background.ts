/**
 * theme-background.mjs —— **背景层渲染器**（四个消费面唯一的一份"怎么画背景"）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它必须是一份共享代码（而不是每处各写十行）
 * ══════════════════════════════════════════════════════════════════════
 * 背景要画到**四个地方**：外壳（app-shell）、新标签页、编辑器迷你预览、其它内部页。
 * 其中两个是**打包**的 ESM（能吃 `@hira-ng/shared-types`），两个是 hira:// 下的
 * **未打包静态页**（只能相对 import）。历史做法是在 `pages/_shared/` 里手抄一份 ——
 * 两份必然漂移，而漂移的表现是"窗口上好好的、新标签页上不对"这类最难查的问题。
 *
 * 所以真源放这里，由 `electron.vite.config.js` 的 sync-shared-contracts 插件按原样
 * 复制成 `hira://shared/theme-background.mjs`（与 favicon-src.mjs / format-size.mjs
 * 同一条机制）。于是四处跑的是**同一份代码**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它只做一件事：把 spec 落到一个容器上
 * ══════════════════════════════════════════════════════════════════════
 * `spec` 是 `theme.mjs#themeBackgroundStyle(bg, scope)` 的产物 ——
 * **"该不该显示、显示成什么样"全在主进程算好**（判据只有一处，见那里的说明），
 * 这里只负责把结果变成 DOM/样式，不做任何业务判断。
 *
 * 三种画法（`spec.mode`）：
 *   · `'css'`   —— `background-image` 三元组（图片 / 渐变 / 纯色）。与改造前逐字相同；
 *   · `'video'` —— 容器里一个 `<video>`（动态壁纸）。**就地复用**元素：只换 `src`，
 *                  不重建 —— 重建会让浏览器把整个文件重新拉一遍、并且闪一帧黑；
 *   · `'none'`  —— 清空，并**销毁**视频元素（`pause` + 摘 `src` + `load`）。
 *                  不做这一步的话，把来源切回纯色后解码器还在后台跑（白烧 GPU/内存）。
 *
 * `opacity` / `filter`（模糊）始终写在**容器**上：视频是它的子元素，所以两档滑杆对
 * 图片与视频**语义完全一致**，不需要"视频另有一套透明度"。
 *
 * 视频的 `muted / loop / playsinline` 是**硬编码**的，不是可配置项 ——
 * 见 docs-ng/主题系统设计.md §6.4.3（动态壁纸出声是骚扰；且自动播放策略本就要求静音）。
 */

/** 视频元素的类名（就地查找/复用的锚点，也是样式表的钩子）。 */
const VIDEO_CLASS = 'hira-bg-video'
/** 只认**容器自己的直接子元素**里的那一个 —— 页面别处的视频不该被误伤。 */
const VIDEO_SELECTOR = `:scope > video.${VIDEO_CLASS}`
/** 自注入样式表的 id（幂等注入用）。 */
const STYLE_ID = 'hira-theme-background-layer-styles'

/** `background.position` → `object-fit`（两套词汇，映射只此一处）。 */
const OBJECT_FIT: Readonly<Record<string, string>> = Object.freeze({
  cover: 'cover',
  contain: 'contain',
  stretch: 'fill',
  // 后两个对视频没有意义（视频不能平铺、"auto" 也不会比 cover 更合适）——都按 cover 处理。
  center: 'cover',
  tile: 'cover'
})

/**
 * 注入视频元素自己的样式（幂等）。
 *
 * 为什么带上自己的一份 CSS 而不是要求各消费面在自己的样式里写：那就会变成
 * "外壳记得写、新标签页忘了写"的第二处真源。它自包含 → 复制到 hira:// 也能直接用。
 */
function ensureStyles(doc: Document | null | undefined): void {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* 背景视频：铺满容器、不参与命中测试。object-fit 由内联样式给（见 OBJECT_FIT）。 */
    .${VIDEO_CLASS} {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      /* 视频不会比容器更大，但保险起见裁掉溢出的那半个像素 */
      overflow: hidden;
    }
  `
  doc.head.appendChild(style)
}

/** 容器里那个背景视频元素（没有则 null）。 */
function findVideo(container: HTMLElement | null): HTMLVideoElement | null {
  if (!container || typeof container.querySelector !== 'function') return null
  try {
    return container.querySelector<HTMLVideoElement>(VIDEO_SELECTOR)
  } catch (_) {
    return null
  }
}

/**
 * 彻底释放一个背景视频。
 *
 * `removeAttribute('src') + load()` 是**必须**的：只 `remove()` 元素时，
 * 部分情况下解码器与网络缓冲会吊着不放（表现为"换了主题，GPU 占用不降"）。
 */
function destroyVideo(video: HTMLVideoElement | null): void {
  if (!video) return
  try { video.pause() } catch (_) {}
  try {
    video.removeAttribute('src')
    video.load()
  } catch (_) {}
  try { video.remove() } catch (_) {}
}

/**
 * 是否应当**停止动态**（无障碍：系统里开了"减少动态效果"）。
 *
 * 动态壁纸是持续动画，对这类用户是明确的负担。命中时**暂停**而不是不加载：
 * 仍然显示第一帧（那是用户自己选的内容），只是不动。
 */
function prefersReducedMotion(doc: Document | null | undefined): boolean {
  try {
    const win = doc && doc.defaultView
    return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch (_) {
    return false
  }
}

/**
 * 让这个视频此刻处于"该播就播、该停就停"的状态（幂等 —— 已经在播就不再调 `play()`）。
 *
 * `play()` 会返回一个 Promise，在自动播放被拦时 reject —— 这里静默吞掉：
 * 静音视频在 Electron 里正常都能播，真播不了也只是停住一帧，不该把异常抛到调用方。
 */
function syncPlayback(video: HTMLVideoElement | null, doc: Document | null | undefined): void {
  if (!video) return
  try {
    if (prefersReducedMotion(doc)) {
      if (!video.paused) video.pause()
      return
    }
    if (video.paused) {
      const p = video.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  } catch (_) {}
}

/**
 * 建/更/用容器里的那个背景视频（**就地复用**，见文件头）。
 *
 * @param {HTMLElement} container
 * @param {string} src 视频地址（`hira-theme://` / `hira-plugin://`）
 * @param {string} position `spec.backgroundPosition`（决定 object-fit）
 */
function syncVideo(container: HTMLElement, src: string, position: string) {
  const doc = container.ownerDocument
  ensureStyles(doc)
  let video = findVideo(container)
  if (!video) {
    video = doc.createElement('video')
    video.className = VIDEO_CLASS
    // 只作装饰：对辅助技术隐藏，也不进 Tab 序。
    video.setAttribute('aria-hidden', 'true')
    video.tabIndex = -1
    // 三条硬编码（见文件头）：静音、循环、行内播放（不允许全屏接管）。
    video.muted = true
    video.setAttribute('muted', '')
    video.loop = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    // 别让"投屏"按钮出现在背景上。
    try { video.disableRemotePlayback = true } catch (_) {}
    video.preload = 'auto'
    container.appendChild(video)
  }
  if (video.getAttribute('src') !== src) {
    video.setAttribute('src', src)
    // 换源必须显式 load()：只改属性时部分情况下不会重新起流。
    try { video.load() } catch (_) {}
  }
  video.style.objectFit = OBJECT_FIT[position] || 'cover'
  syncPlayback(video, doc)
}

/**
 * 每个容器上一次落下去的那份 spec（指纹串）。
 *
 * 编辑器拖动滑杆时，预览每帧都会重算整份背景并调到这里 —— 而绝大多数帧里
 * 背景一个字都没变（变的是 Chrome 配色）。没有这层记忆时，每帧都会写 6 个样式属性
 * 并 `querySelector` 找一次视频元素，白白触发样式重算。
 */
const appliedSpecs = new WeakMap<HTMLElement, string>()

/** spec → 指纹（只含真正会落到 DOM 上的那几个值）。 */
function specFingerprint(effective: 'none' | 'css' | 'video', s: ThemeBackgroundSpec | null, videoSrc: string): string {
  const css = effective === 'css'
  return [
    effective,
    css ? (s?.backgroundImage || '') : '',
    css ? (s?.backgroundSize || '') : '',
    css ? (s?.backgroundPosition || '') : '',
    css ? (s?.backgroundRepeat || '') : '',
    effective === 'video' ? videoSrc : '',
    effective === 'video' ? (s?.backgroundPosition || 'cover') : '',
    s && s.opacity != null && s.opacity !== '' ? String(s.opacity) : '1',
    (s && s.filter) || ''
  ].join('\u0001')
}

/**
 * 把 spec 落到容器上（渲染侧唯一入口）。
 *
 * @param {HTMLElement|null} container 背景层（外壳的 `#chrome-theme-background-image`、
 *   主题预览的 `.thm-preview__bg` …）。
 *   注意：**壁纸只在窗口外壳画一份**，任何页面（含新标签页）都不要再调用它 ——
 *   页面里再画一份就会跟着面板/侧栏动画一起动、并对不齐（见主题系统设计 §6.2.2）。
 * @param {ReturnType<import('./theme.js').themeBackgroundStyle>|any} spec
 *   `themeBackgroundStyle(bg, scope)` 的产物；传 null / 空 = 什么也不画。
 * @returns {'none'|'css'|'video'} 实际采用的画法（给调用方做后续判断用）
 */
export interface ThemeBackgroundSpec {
  visible?: boolean
  mode?: 'none' | 'css' | 'video'
  videoSrc?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  opacity?: string | number
  blur?: string | number
  overlayColor?: string
  filter?: string
}

export function applyThemeBackground(
  container: HTMLElement | null,
  spec: ThemeBackgroundSpec | null | undefined
): 'none' | 'css' | 'video' {
  if (!container || !container.style) return 'none'
  const doc = container.ownerDocument
  const s = spec && typeof spec === 'object' ? spec : null
  const mode = s && (s.mode === 'video' || s.mode === 'css') ? s.mode : 'none'
  const videoSrc = mode === 'video' ? String(s?.videoSrc || '') : ''
  // 视频地址拿不到（资产丢了 / 图还没生成）→ 退回"什么也不画"，露出主题底色。
  const effective = mode === 'video' && !videoSrc ? 'none' : mode

  const fingerprint = specFingerprint(effective, s, videoSrc)
  if (appliedSpecs.get(container) === fingerprint) {
    // 值没变：样式一个字都不写。唯一例外是视频可能被浏览器暂停（切后台 / 睡醒回来），
    // 这里补一次"该播就播"（幂等 —— 正在播就不会重复调 play()）。
    if (effective === 'video') {
      const video = findVideo(container)
      if (video && video.paused) syncPlayback(video, doc)
    }
    return effective
  }
  appliedSpecs.set(container, fingerprint)

  const style = container.style
  if (effective === 'css') {
    style.backgroundImage = s?.backgroundImage || 'none'
    style.backgroundSize = s?.backgroundSize || 'auto'
    style.backgroundPosition = s?.backgroundPosition || 'center'
    style.backgroundRepeat = s?.backgroundRepeat || 'no-repeat'
  } else {
    // 视频与"无背景"都不留 CSS 图（不清掉的话，切来源时会残留上一张图）。
    style.backgroundImage = 'none'
    style.backgroundSize = 'auto'
    style.backgroundPosition = 'center'
    style.backgroundRepeat = 'no-repeat'
  }
  style.opacity = s && s.opacity != null && s.opacity !== '' ? String(s.opacity) : '1'
  style.filter = (s && s.filter) || ''

  if (effective === 'video') {
    syncVideo(container, videoSrc, s?.backgroundPosition || 'cover')
  } else {
    destroyVideo(findVideo(container))
  }
  return effective
}

export { VIDEO_CLASS as THEME_BACKGROUND_VIDEO_CLASS }

/**
 * performance.mjs —— 性能相关设置的**键名 / 缺省值唯一真源**。
 *
 * 这四个键的读取点彼此相隔很远，却必须指的是同一批设置：
 *   · `hardware_acceleration` / `smooth_scrolling` —— app ready **之前**就要
 *     决定的 Chromium 开关（app/preboot.js 直读设置文件）；
 *   · `memory_saver` —— 内存压力回收的定时器（module-bootstrap）；
 *   · `cpu_throttle_background` —— 标签后台节流生效器（settings/appliers/performance）；
 *   · 设置页字段表（settings/registry）与域层默认值（domain-settings）。
 *
 * `hardware_acceleration` / `smooth_scrolling` 还必须住在全局设置文件里
 * （启动期不知道当前 profile，见 settings-scope#BOOT_SETTING_KEYS）——
 * 键名写错一次的表现是「设置改了、重启后毫无变化」，且不报任何错。
 */

export const PERFORMANCE_SETTING_KEYS = Object.freeze({
  /** 硬件加速（关闭后需重启） */
  hardwareAcceleration: 'performance.hardware_acceleration',
  /** 平滑滚动（Chromium 开关，需重启） */
  smoothScrolling: 'performance.smooth_scrolling',
  /** 内存压力时释放缓存 / 触发 GC */
  memorySaver: 'performance.memory_saver',
  /** 后台（非活动）标签是否降频 */
  cpuThrottleBackground: 'performance.cpu_throttle_background'
})

/** 四项缺省值（键 = 真实设置键）—— 域层默认值与设置页兜底显示共用。 */
export const DEFAULT_PERFORMANCE_SETTINGS = Object.freeze({
  [PERFORMANCE_SETTING_KEYS.hardwareAcceleration]: true,
  [PERFORMANCE_SETTING_KEYS.smoothScrolling]: true,
  [PERFORMANCE_SETTING_KEYS.memorySaver]: true,
  [PERFORMANCE_SETTING_KEYS.cpuThrottleBackground]: true
})

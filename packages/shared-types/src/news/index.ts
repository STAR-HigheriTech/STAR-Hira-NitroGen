/**
 * 新闻 / 订阅源共享套件 —— 唯一入口。
 *
 * 复用者（都从这里 import，认一条口子）：
 *   · NTP 新标签页新闻组件（apps 层页面）
 *   · 侧栏「实时更新」Live Folders 面板（ui 层）
 *
 * 副作用导入 = 注册内置源（注册顺序即降级链顺序：可靠的排前面，curated 兜底最后）。
 * 「再加一个源」= providers/ 里加一个 .mjs 并在下方补一行 import。
 */
import './providers/sspai.js'
import './providers/hackernews.js'
import './providers/devto.js'
import './providers/curated.js'

export * from './registry.js'
export * from './http.js'
export * from './service.js'

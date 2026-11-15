// 首帧后立刻需要可用的页面能力。分组由 tab-preload 的延迟装载器求值，
// 模块内部仍保持各自独立、自启动，装配层不包含任何业务判据。

import './gestures/index.js'
import './file-drop/index.js'
import './internal-drag/index.js'
import './spatial-nav/index.js'
import './translate/index.js'
import './pwa-hints/index.js'

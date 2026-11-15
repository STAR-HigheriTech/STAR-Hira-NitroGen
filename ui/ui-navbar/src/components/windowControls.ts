/**
 * 窗口控制按钮簇 —— **本体已上移到 @hira-ng/ui-common**（`windowControls.ts`）。
 *
 * 为什么挪走：这一簇不再只属于导航栏 —— 垂直标签侧栏（ui-vertical-tabs 的底槽）
 * 也要画同一簇，否则侧栏落在底行时会凭空少掉三颗按钮（"看起来完全不是同一条侧栏"）。
 * 两份造法必然漂移，所以造法只留一份，放在跨视图共用的 ui-common 里。
 *
 * 本文件保留为**再导出**（ui-navbar 的对外契约不变：`createWindowControls` 仍从这里拿），
 * 免得所有调用点跟着改一行 import —— 真正的实现请看 ui-common/src/windowControls.ts。
 */

export { WINDOW_CONTROLS_CSS, createWindowControlCluster as createWindowControls } from '@hira-ng/ui-common'

import { tabsClient } from './tabs-client.js'
import { panelsClient } from './panels-client.js'
import { layoutClient } from './layout-client'
import { bookmarksClient } from './bookmarks-client.js'
import { notesClient } from './notes-client.js'
import { totpClient } from './totp-client.js'
import { settingsClient } from './settings-client.js'
import { extensionsClient } from './extensions-client.js'
import { spaceClient } from './space-client.js'
import { profilesClient } from './profile-client.js'
import { pluginsClient } from './plugins-client.js'
// 屏幕抓帧（「扫码器」插件的端口）—— 抓屏在主进程做，这里只是调用口
import { screenCaptureClient } from './screen-capture-client.js'
// 会话（自动快照 + 命名会话）：面板与内部页共用同一端口，避免各写一份规则
import { sessionClient } from './session-client.js'
// 功能面可用性（§10.4）：单例 store + 一条桥订阅，UI 入口只问它"某引擎还在不在"。
import { featuresClient, onFeaturesChanged, isFeatureAvailable } from './features-client.js'
// AI 助手（第一方插件提供能力，禁用即通道消失 —— 调用方按 reject 处理「不可用」）
import { aiClient } from './ai-client.js'

export {
  tabsClient, panelsClient, layoutClient, bookmarksClient, settingsClient,
  extensionsClient, spaceClient, profilesClient, pluginsClient,
  notesClient,
  totpClient,
  screenCaptureClient,
  sessionClient,
  featuresClient, onFeaturesChanged, isFeatureAvailable,
  aiClient
}

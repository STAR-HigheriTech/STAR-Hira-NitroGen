/**
 * infra-pwa —— PWA 安装的原子能力层（下载 / 图标 / 快捷方式）。
 *
 * 分层约束：
 *  · 本层只做「可复用的系统操作」，不认识数据库、不认识窗口、不认识 IPC；
 *  · 业务编排（何时探测、装在哪、失败怎么回滚）全部在 apps/app-main/src/main/pwa/*；
 *  · 纯规则（URL/scope/appId/两档判定）在 domain/domain-pwa。
 *
 * 扩展点：
 *  · 平台快捷方式 → registerShortcutDriver(platform, driver)；
 *  · 新图标格式 → 在 icon-store.sniffImage 的魔数表里加一行即可。
 */

export * from './manifest-fetch'
export * from './page-hints'
export * from './icon-store'
export * from './ico'
export * from './shortcut'

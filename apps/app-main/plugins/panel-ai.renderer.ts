/**
 * AI 助手面板 —— 由**插件自带**的渲染侧实现（`entry.render` 的用例）。
 *
 * 本文件只有二十行：把「样式 + 装配根」交给宿主，并在面板销毁时收口。
 * 真正的实现分在 `ai/ui/` 下，各文件互不认识：
 *   ui/panel.js       装配根（视图接线 / 迁移快照）
 *   ui/store.js       状态与数据来源（IPC 客户端的语义化封装）
 *   ui/chat.js        消息流（增量 reconcile + 流式片段）
 *   ui/composer.js    输入区（@ / / 浮层、拖入、模型选择）
 *   ui/sessions.js    会话抽屉
 *   ui/styles.js      唯一样式收口
 *
 * 设置**不在这里**：模型服务 / 用量在内部页 `hira://aisettings`（src/pages/aisettings），
 * 技能（已插件化）在插件页的「AI 技能」大类（`hira://plugins#ai-skill-plugin`）。
 * 面板齿轮、输入区提示、设置页 AI 分区都打开同一处配置 —— 两个形态共用一份。
 *
 * 契约（见 renderer/shared/plugin-renderer.js）：
 *   export const rendererPlugin = { panels: [panelDefinition] }
 * `panels[].id` 必须等于 manifest `contributes.panels[].id`（这里都是 `ai-panel`）。
 */

import { createAiPanel } from './ai/ui/panel.js'
import { injectAiPanelStyles } from './ai/ui/styles.js'

/** 插件自带的面板定义（宿主按 id 对齐 manifest 的 contributes.panels）。 */
export const panelDefinition = {
  id: 'ai-panel',
  injectStyles: injectAiPanelStyles,
  async mount(doc: Document, ctx: unknown) {
    const content = await createAiPanel(doc, ctx as Parameters<typeof createAiPanel>[1]) as
      Awaited<ReturnType<typeof createAiPanel>> & { dispose?(): void }

    // 面板被宿主销毁时收口（面板视图关闭即销毁，不做跨面板复用）。
    const win = doc.defaultView
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', () => {
        try { content.dispose?.() } catch (_) {}
      }, { once: true })
    }

    // 宿主端口 = `createAiPanel` 的能力集**原样透传**（spread，而不是手抄一份白名单）。
    //
    // ⚠ 这里曾经是手抄的 `{ element, focusSearch, refresh, serialize, restore }`，
    //   漏了 `ask` —— 于是内部页 `hira://ai?ask=…` 的深链永远走不进
    //   `typeof mounted.ask === 'function'`，用户点了地址栏第一行却什么都不发生。
    //   以后给 `createAiPanel` 加能力（导出会话 / 重试 / …），宿主自动拿得到，
    //   不会再出现"新能力只在一个宿主可用"的第二套白名单。
    return { ...content }
  }
}

export const rendererPlugin = {
  panels: [panelDefinition]
}

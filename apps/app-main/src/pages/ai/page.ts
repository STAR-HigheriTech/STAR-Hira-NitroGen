// @ts-check
/**
 * `hira://ai` —— **AI 助手（内部页形态）**。
 *
 * ── 三种宿主、一份实现 ────────────────────────────────────────────────
 * 侧栏面板（`renderer/panels/host.js`）、独立窗口（`renderer/subwindow/windows/
 * detached-panel.js`）与本页，装的是**同一份** `plugins/panel-ai.renderer.js#panelDefinition`：
 *   · 端口由 `shared/panel-context.js` 统一构造（这里传 `compact: false`、`host: 'page'`，
 *     与窗口态同密度）；
 *   · 聊天 UI 全在 `plugins/ai/ui/*`，本文件不画任何一个部件 —— 否则就是第二套聊天界面；
 *   · 跨宿主状态分两类（见 `plugins/ai/main/ui-state.cjs` 文件头）：**会话按宿主分槽**
 *     （面板 / 窗口 / 本页各自停在不同对话上互不干扰，换宿主时会话随迁移快照带走），
 *     模型 / 推理档位 / 审批模式三宿主共用一份。都由 store 自己读写，本页无需接线。
 *
 * ── 与 detached-panel 的唯一差别 ──────────────────────────────────────
 * 窗口版还要处理「面板目录 → 标题」「停靠回侧栏按钮」「payload 快照回填」这些
 * **窗口才有的东西**；本页是常驻标签，标题来自 `pages.mjs`，没有迁移动作，因此
 * 装配顺序只剩下：注入样式 → 造端口 → mount → 挂 DOM。
 *
 * ── 构建方式（重要）──────────────────────────────────────────────────
 * 内部页是"原样拷贝、不打包"的静态页，而 `panelDefinition` 位于 `plugins/`（不在
 * 拷贝树里、且 renderer 的 Vite 产物带着 `import.meta.glob`）—— 所以本文件由
 * `electron.vite.config.js#bundleSourcePagesPlugin` 在**构建期**用 esbuild 从源码打成
 * 自包含单文件，`hira://` 协议 URL 保持 external。别在浏览器里静态 import
 * `renderer/shared/plugin-slots.js` / `plugin-resolve.js`：那条链会求值
 * `import.meta.glob`，整页白屏。
 */

import { initTheme } from 'hira://shared/runtime.js'
import { panelDefinition } from '../../../plugins/panel-ai.renderer'
import { createPanelContext, setPanelRefresh } from '../../renderer/shared/panel-context.js'
import type { RendererBridge } from '../../renderer/shared/bridge.js'
import type { PanelInstance } from '../../renderer/shared/panel-definition.js'

initTheme()

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const root = (() => {
  const element = document.getElementById('ai-root')
  if (!element) throw new Error('AI page root is unavailable')
  return element
})()

/** 兜底文案（与 detached-panel 的兜底同口径：一行居中，不画半成品外壳）。 */
function renderFallback(text = ''): void {
  root.textContent = ''
  const p = document.createElement('p')
  p.className = 'ai-page__fallback'
  p.textContent = text
  root.appendChild(p)
}

async function boot(): Promise<void> {
  const bridge = window.hira as RendererBridge | undefined
  if (!bridge) {
    renderFallback('渲染桥不可用（preload 未加载）')
    return
  }

  try {
    if (typeof panelDefinition.injectStyles === 'function') panelDefinition.injectStyles(document)
  } catch (e) {
    console.error('[ai-page] 注入面板样式失败:', e)
  }

  const ctx = createPanelContext({
    bridge,
    panelId: panelDefinition.id,
    compact: false,
    previewOverlay: null,
    host: 'page'
  })

  let mounted: (PanelInstance & { ask?(text: string): Promise<unknown> }) | null = null
  try {
    mounted = await panelDefinition.mount(document, ctx)
  } catch (e) {
    console.error('[ai-page] 面板装配失败:', e)
    renderFallback(`AI 助手装配失败：${errorText(e, String(e))}`)
    return
  }

  setPanelRefresh(mounted && typeof mounted.refresh === 'function' ? mounted.refresh : null)
  if (mounted && mounted.element) root.appendChild(mounted.element)

  // ── 深链 `hira://ai?ask=<内容>`：地址栏下拉第一行「询问 AI」的落点 ──
  // 面板先挂上再发问（否则"用户点了第一行却什么也看不到"）；发送后立刻把 query
  // 从地址里抹掉 —— 会话已经记下这条消息，刷新 / 前进后退不该重复提问。
  const askText = readAskParam()
  if (askText) {
    if (mounted && typeof mounted.ask === 'function') {
      try {
        // ask 内部会先创建新会话再发送；返回 { ok:false } 时原文已回填输入区。
        await mounted.ask(askText)
        clearAskParam()
      } catch (e) {
        // 未完成的提问不从地址栏抹掉：刷新或重试仍有机会执行，不能静默吞内容。
        console.error('[ai-page] 自动发问失败:', e)
      }
    } else {
      // 面板没透出 `ask`（宿主包装层漏转发）时这里以前是**静默跳过** ——
      // 用户只看到"点了第一行，什么都没发生"。留一条显式告警，避免同类问题再无声无息。
      console.warn('[ai-page] 面板未提供 ask 能力，深链 ?ask= 未执行:', askText)
    }
  }
}

/** 读取 `?ask=`（解码后去空白；没有 / 空串返回 ''）。 */
function readAskParam(): string {
  try {
    return (new URLSearchParams(window.location.search).get('ask') || '').trim()
  } catch (_) {
    return ''
  }
}

/** 把 `?ask=` 从当前地址抹掉（保留其它参数与 hash）。 */
function clearAskParam(): void {
  try {
    const clean = new URL(window.location.href)
    clean.searchParams.delete('ask')
    window.history.replaceState(null, '', clean.href)
  } catch (_) {}
}

boot().catch((e: unknown) => {
  console.error('[ai-page] 启动失败:', e)
  renderFallback(`AI 助手启动失败：${errorText(e, String(e))}`)
})

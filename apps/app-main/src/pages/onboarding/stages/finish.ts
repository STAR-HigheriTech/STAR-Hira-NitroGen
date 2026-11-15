/**
 * 阶段 · 完成
 *
 * 主按钮走 `ctx.complete()`（onboarding:complete）：主进程先挂主窗口、记版本号，
 * 再销毁本窗。因此本阶段 onNext 永远返回 false —— 成功路径下本页已被销毁，
 * 返回 true 只会去推进不存在的下一步。
 *
 * 导入不再挂在这里：需要导入的用户在流程里已经走过 migrate 那一屏
 * （Hira Min 紧跟欢迎页，其它浏览器在完成前一步），这里只负责回顾 + 收尾。
 * 关窗语义不变：任何时候关掉这个窗口都等于结束引导。
 */

import { STARTUP_MODES } from 'hira://shared/startup.mjs'
import type { OnboardingContext, OnboardingStage, UserSource } from './types.js'

// 值集合以 shared-types/startup.mjs 为准；这里只提供本页展示文案。
const MODE_COPY: Record<string, string> = {
  blank: '空白页',
  home: '主页 / 快速拨号',
  custom: '自定义网页',
  last_session: '恢复上次会话'
}
const STARTUP_LABEL: Record<string, string> = Object.fromEntries(
  STARTUP_MODES.filter((mode) => MODE_COPY[mode]).map((mode) => [mode, MODE_COPY[mode]])
)

const SOURCE_LABEL: Record<UserSource, string> = {
  other: '其它浏览器',
  min: 'Hira Min'
}

const MIGRATE_LABEL: Record<string, string> = {
  bookmarks: '书签',
  passwords: '密码',
  'browser-import': '浏览器数据'
}

const finish: OnboardingStage = {
  id: 'finish',
  label: '完成',
  nextLabel: '开始使用',
  hint: '按 Enter 立刻开始使用',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', '一切就绪'))
    root.appendChild(ctx.el('p', 'oobe-sub', '常用设置已经保存，之后可以在设置中继续调整。'))

    const recap = ctx.el('div', 'oobe-recap')
    const chips: Array<[string, string]> = []
    chips.push(['来源', SOURCE_LABEL[ctx.draft.source] || SOURCE_LABEL.other])
    if (ctx.draft.themeName) chips.push(['主题', ctx.draft.themeName])
    if (ctx.draft.layout && ctx.draft.layout.label) chips.push(['布局', ctx.draft.layout.label])
    if (ctx.draft.startupMode) {
      chips.push(['启动', STARTUP_LABEL[ctx.draft.startupMode] || ctx.draft.startupMode])
    }
    for (const [id, result] of Object.entries(ctx.draft.migration || {})) {
      chips.push([MIGRATE_LABEL[id] || id, migrationText(result)])
    }
    if (chips.length === 1) chips.push(['配置', '全部使用默认值'])
    for (const [key, value] of chips) {
      const item = ctx.el('span', 'oobe-recap-item')
      item.append(ctx.el('b', undefined, key + '：'), document.createTextNode(value))
      recap.appendChild(item)
    }
    root.appendChild(recap)
    return root
  },

  async onNext (ctx: OnboardingContext) {
    await ctx.complete()
    return false
  }
}

export default finish

function migrationText (result?: { ok: boolean; count?: number; cancelled?: boolean }): string {
  if (!result) return '未导入'
  if (result.ok) {
    if (!Number.isFinite(result.count)) return '已完成'
    return result.count === 0 ? '无新增数据' : `已导入 ${result.count} 项`
  }
  if (Number.isFinite(result.count) && Number(result.count) > 0) {
    return `已写入 ${result.count} 项，部分失败`
  }
  return result.cancelled ? '已跳过' : '未完成'
}

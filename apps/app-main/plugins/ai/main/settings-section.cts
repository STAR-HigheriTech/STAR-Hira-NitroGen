/**
 * AI 助手 · 设置页分区（`settings.section-renderer`，PART15 §13）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这里只有一个入口、没有第二套编辑器
 * ══════════════════════════════════════════════════════════════════════
 * 模型的增删改、用量统计**只有一处实现**：内部页 `hira://aisettings`（`src/pages/aisettings/`）；
 * 技能（已插件化）只有一处实现：插件页的「AI 技能」大类（`hira://plugins#ai-skill-plugin`）。
 * 面板与独立窗口共用那两页，设置页只管把用户送过去 ——
 * 若在这里再画一份表单，就是第二份实现：校验、密钥"只写不读"的规则立刻开始漂移。
 *
 * 入口走 `href`（内部页）而不是 `route`（面板动作）：
 *   · 设置是**两个形态共用**的，跳到面板会把"窗口模式"的用户塞回侧栏；
 *   · 内部页可深链（`hira://aisettings`、`hira://plugins#ai-skill-plugin`），也能被收藏 / 前进后退。
 *
 * 真正属于「设置」而不是「某次配置动作」的字段（人格提示、默认上下文开关、
 * 站点授权、附件上限…）在 Phase 1/3 落地时**加在这里**（`fields`），
 * 因为它们的消费方是引擎，不是面板。
 *
 * 禁用 `ai-engine` 时本分区整段消失 —— `collectPluginSections()` 每次请求现算，
 * 分组随插件生命周期走（§5.2 零残留）。
 */

const { pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')

/**
 * @returns {{ id: string, label: string, group: string, icon: string, blurb: string, entry: Array<object>, fields: Array<object> }}
 */
function aiSettingsSection() : { id: string, label: string, group: string, icon: string, blurb: string, entry: Array<object>, fields: Array<object> } {
  return {
    id: 'ai',
    label: 'AI 助手',
    // 只认 `packages/shared-types/src/settings-groups.mjs` 里的合法 id。
    group: 'tools',
    icon: 'puzzle',
    blurb: '模型服务与用量统一在「AI 设置」页配置；聊天界面是独立的「AI 助手」页；技能已插件化，管理入口在插件页的「AI 技能」大类。',
    entry: [
      {
        label: '打开 AI 设置',
        desc: '添加模型服务、查看用量与导出审计日志。',
        action: '打开',
        href: pageUrl('aisettings')
      },
      {
        label: '打开 AI 助手',
        desc: '与侧栏面板 / 独立窗口共享同一份会话的完整聊天页。',
        action: '打开',
        href: pageUrl('ai')
      },
      {
        label: '管理 AI 技能',
        desc: '内置与第三方技能清单、用户自建技能、导入导出与逐条启停。',
        action: '打开',
        href: `${pageUrl('plugins')}#ai-skill-plugin`
      }
    ],
    fields: []
  }
}

module.exports = { aiSettingsSection }

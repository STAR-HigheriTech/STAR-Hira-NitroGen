/**
 * 标签栏（ui-tabbar）视觉回归的 **case 表** —— 纯数据，不含任何逻辑。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份基线是干什么用的
 * ══════════════════════════════════════════════════════════════════════
 * `tabbar.*` 的插槽（`item-renderer` / `tab-stack-renderer` / `drop-target`）要在
 * `ui/ui-tabbar` 里接线。标签条是整个界面**最热**的渲染路径
 * （每次切标签、每次收标签都会重画），改它之前必须先有一版"现在的样子"，
 * 改完 diff 一眼就能看出"有没有画坏"。
 *
 * 所以这不是普通的单元测试：它**只**回答一个问题 —— "和上次相比，像素变了没有"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 怎么加 case
 * ══════════════════════════════════════════════════════════════════════
 * 加一条 = 在下面加一个对象。字段：
 *   · `id`     三位编号（决定文件名与执行顺序）
 *   · `name`   语义名（会进文件名，用 kebab-case）
 *   · `theme`  `light` / `dark` —— 主题变量不同，别只测浅色
 *   · `width` / `height`  截图区域（CSS 像素）
 *   · `tabs`   直接喂给 `createTabbar().renderTabs()` 的投影数组
 *   · `decorations` （可选，布尔）置 true 时页面侧会注入**测试装饰器**，
 *     模拟插件往标签行尾 / 芯片尾追加自己的 DOM（`tabbar.item-renderer` +
 *     `tabbar.tab-stack-renderer`）。装饰层是宿主最容易被改坏的地方之一
 *     （落点、`pointer-events: none`、以及"标签宽度被挤掉多少"都是布局问题），
 *     所以它也需要一条像素基线钉住。
 *
 * `tabs` 的两种形态（与真实投影一致，见 `domain-tabs/TabStacks.js`）：
 *   · 散标签：`{ tabId, title, url, favicon?, active?, pinned?, muted?, isPlaying?, isLoading?, incognito?, stackId? }`
 *   · 标签组：`{ type: 'stack', stackId, label, count, accent?, collapsed, children: [tabId…] }`
 *
 * ⚠ 别用真实网页地址做数据：基线的价值在于**只**反映渲染器，任何会随网络/时间变的东西
 * （favicon 图片、真实标题）都会让基线永远在飘。这里一律用固定字符串 + 不设 favicon.src。
 */

/** 通用的假标题，避免每处重复写字面量。 */
const T = (n: number | string): string => `标签页 ${n}`

module.exports = [
  {
    id: '001',
    name: 'tabs-basic',
    theme: 'light',
    width: 900,
    height: 44,
    // 最朴素的形态：三个散标签，第一个激活。任何改动只要碰到基础行结构，这一条必红。
    tabs: [
      { tabId: 't1', title: T(1), url: 'https://example.test/1', active: true },
      { tabId: 't2', title: T(2), url: 'https://example.test/2' },
      { tabId: 't3', title: T(3), url: 'https://example.test/3' }
    ]
  },
  {
    id: '002',
    name: 'tab-states',
    theme: 'light',
    width: 900,
    height: 44,
    // 单个标签的全部状态各来一个 —— 这一条覆盖 favicon 区、音频指示、关闭按钮、
    // 固定态与加载态的全部视觉分支。
    tabs: [
      { tabId: 's1', title: '激活', url: 'https://example.test/a', active: true },
      { tabId: 's2', title: '固定', url: 'https://example.test/b', pinned: true },
      { tabId: 's3', title: '静音', url: 'https://example.test/c', muted: true },
      { tabId: 's4', title: '播放中', url: 'https://example.test/d', isPlaying: true },
      { tabId: 's5', title: '加载中', url: 'https://example.test/e', isLoading: true },
      { tabId: 's6', title: '无痕', url: 'https://example.test/f', incognito: true }
    ]
  },
  {
    id: '003',
    name: 'tab-stack-expanded',
    theme: 'light',
    width: 900,
    height: 44,
    // 展开的标签组：芯片 + 两个有 stackId 的成员。
    // 成员会拿到 .in-tab-stack（底部细线让位给组下划线）—— 那一整套竖条/下划线绘制
    // 最容易在改渲染器时被碰坏，所以必须有基线。
    tabs: [
      { tabId: 'x1', title: T(1), url: 'https://example.test/1' },
      {
        type: 'stack',
        stackId: 'st1',
        label: '工作',
        accent: '#1a73e8',
        collapsed: false,
        count: 2,
        children: ['x2', 'x3']
      },
      { tabId: 'x2', title: T(2), url: 'https://example.test/2', stackId: 'st1' },
      { tabId: 'x3', title: T(3), url: 'https://example.test/3', stackId: 'st1', active: true }
    ]
  },
  {
    id: '004',
    name: 'tab-stack-collapsed',
    theme: 'light',
    width: 900,
    height: 44,
    // 折叠的标签组：成员不在投影里，只有芯片（箭头方向也不同）。
    tabs: [
      { tabId: 'y1', title: T(1), url: 'https://example.test/1', active: true },
      {
        type: 'stack',
        stackId: 'st2',
        label: '阅读',
        accent: '#9334e6',
        collapsed: true,
        count: 4,
        children: ['y2', 'y3', 'y4', 'y5']
      },
      { tabId: 'y6', title: T(6), url: 'https://example.test/6' }
    ]
  },
  {
    id: '005',
    name: 'tabs-overflow',
    theme: 'light',
    width: 900,
    height: 44,
    // 溢出：标签会被压缩到最小宽度（收缩规则写在样式表里）。
    // "标签多了以后排版崩掉 / 不再收缩 / 溢出滚动条位置不对"都会在这里露出来。
    tabs: Array.from({ length: 18 }, (_, i) => ({
      tabId: `o${i + 1}`,
      title: T(i + 1),
      url: `https://example.test/${i + 1}`,
      active: i === 4
    }))
  },
  {
    id: '006',
    name: 'tabs-dark',
    theme: 'dark',
    width: 900,
    height: 44,
    // 深色主题下的同一组状态。主题变量（--hira-*）走的是另一套取值，
    // "浅色对、深色糊成一片"是这类组件最常见的回归，所以两种主题都要钉住。
    tabs: [
      { tabId: 'd1', title: T(1), url: 'https://example.test/1', active: true },
      { tabId: 'd2', title: T(2), url: 'https://example.test/2', pinned: true },
      { tabId: 'd3', title: T(3), url: 'https://example.test/3', muted: true },
      {
        type: 'stack',
        stackId: 'st3',
        label: '项目',
        accent: '#e8710a',
        collapsed: false,
        count: 1,
        children: ['d4']
      },
      { tabId: 'd4', title: T(4), url: 'https://example.test/4', stackId: 'st3' }
    ]
  },
  {
    id: '007',
    name: 'tab-decorations',
    theme: 'light',
    width: 900,
    height: 44,
    // 装饰层：两个装饰插槽接线后，插件会往每一行的**尾部**追加一块 DOM
    //（标签行 + 标签组芯片各一处）。这一条把"追加在哪、挤掉多少宽度、
    // 有没有把关闭按钮顶出可视区"钉下来。
    decorations: true,
    tabs: [
      { tabId: 'p1', title: T(1), url: 'https://example.test/1', active: true },
      { tabId: 'p2', title: T(2), url: 'https://example.test/2' },
      {
        type: 'stack',
        stackId: 'st7',
        label: '研究',
        accent: '#1a73e8',
        collapsed: false,
        count: 1,
        children: ['p3']
      },
      { tabId: 'p3', title: T(3), url: 'https://example.test/3', stackId: 'st7' }
    ]
  }
]

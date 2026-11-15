/**
 * 推广页 · 内容数据
 *
 * ⚠ **这里的每一条都来自官网原文，不要凭空编**。
 * 来源：https://www.higheri.tech/ （读取时间 2026-10-07）
 * 官网改版后照着这份文件更新即可，渲染逻辑不用动（见 promotion.js）。
 *
 * ── 只放"值得推"的 ────────────────────────────────────────────────────────
 * · **STAR Hira 不放**：那是我们自己（这一页就在 Hira 里），自己推自己没有意义。
 * · **HigheriTab 不放**：它的入口和 Hira 同一个地址，本质是同一件事。
 * · **路线图 / 品牌理念不放**：那是官网"关于我们"的内容，不是推广。
 *   推广页只该有一件事：告诉用户现在能用什么、去哪拿。
 */

export const BRAND = Object.freeze({
  name: 'STAR HigheriTech',
  site: 'https://www.higheri.tech/',
  docs: 'https://docs.higheri.tech/',
  github: 'https://github.com/STAR-HigheriTech'
})

/** 头图位：当期主推 —— HigheriPE 全新 6.0。 */
export const HERO = Object.freeze({
  eyebrow: '全新 6.0',
  title: 'HigheriPE',
  desc: '面向系统安装、维护与修复的 PE 工具箱。',
  points: ['PE 可安装到本地', '更便捷的插件功能', '个人免费使用'],
  primary: { label: '立即获取', url: 'https://www.higheri.tech/VIEW/PE/PE.html' },
  secondary: { label: '产品文档', url: 'https://docs.higheri.tech/' }
})

/**
 * 其余产品（官网 Core Products 去掉 Hira / HigheriTab 之后剩下的两个）。
 * 就两个，不硬凑 —— 凑进来的每一条都会稀释"这一页在推什么"。
 */
export const PRODUCTS = Object.freeze([
  {
    tag: '生产力',
    name: 'HigheriDraft',
    desc: '跨端同步的草稿与待办记录工具。',
    url: 'https://www.higheri.tech/webp/DRAFT/index.html'
  },
  {
    tag: '开发者工具',
    name: 'STAR EasyCMD',
    desc: '把常用命令整理成可复用的操作模块。',
    url: 'https://www.higheri.tech/VIEW/PE/PE.html'
  }
])

/**
 * 伙伴位（官网赞助区块）。
 * 这是**第三方广告**，所以界面上会明确标出「广告」，不与自家产品混在一起 ——
 * 做得显眼是应该的，但"显眼"不等于模糊掉"这是谁在说话"。
 */
export const SPONSOR = Object.freeze({
  label: '广告',
  brand: '伤心的云',
  /** 官网原话的优惠信息，作为这一块的主钩子 */
  kicker: '限时特惠 · 香港 ¥9.9/月起',
  url: 'https://sadidc.com/',
  /** `hot: true` 的那条在界面上会加重 —— 对应官网自己标的"爆款" */
  plans: [
    { badge: '爆款', hot: true, name: '香港 happy', price: '¥9.9', unit: '/月', spec: '1核 / 1G / 30G / 10Mbps · 香港 CN2' },
    { badge: '推荐', name: '美国 eagle', price: '¥12.99', unit: '/月', spec: '1核 / 1GB / 10G / 500Mbps · 美国直连' },
    { badge: '游戏', name: '游戏云', price: '¥12', unit: '/月', spec: '2核 / 4G / 40G / 15Mbps · 游戏优化' }
  ]
})

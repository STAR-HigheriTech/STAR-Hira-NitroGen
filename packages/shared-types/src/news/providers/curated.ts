/**
 * 新闻源 · 精选（离线兜底）
 *
 * 这是降级链的**最后一环，也是唯一保证成功的一环**：不联网、不会失败。
 * 于是无论断网、接口挂了、还是被限流，列表永远有内容可显示，
 * 而不是给用户一张"加载失败"的空白卡。
 *
 * 内容定位：国内主流新闻/媒体入口 + 各平台热榜入口 —— 既是"推广位"，
 * 也是断网时真的能点进去的导航。顺序即展示顺序，改这里就是改默认推广内容。
 */
import { defineProvider } from '../registry.js'

const CURATED = [
  ['新华网 · 要闻', 'http://www.news.cn/politics/', '新华网'],
  ['人民网 · 时政', 'http://politics.people.com.cn/', '人民网'],
  ['澎湃新闻 · 要闻', 'https://www.thepaper.cn/', '澎湃'],
  ['界面新闻', 'https://www.jiemian.com/', '界面'],
  ['财新网', 'https://www.caixin.com/', '财新'],
  ['第一财经', 'https://www.yicai.com/', '一财'],
  ['IT之家 · 今日要闻', 'https://www.ithome.com/', 'IT之家'],
  ['36氪 · 快讯', 'https://36kr.com/newsflashes', '36氪'],
  ['虎嗅网', 'https://www.huxiu.com/', '虎嗅'],
  ['少数派', 'https://sspai.com/', '少数派'],
  ['知乎热榜', 'https://www.zhihu.com/hot', '知乎'],
  ['微博热搜榜', 'https://s.weibo.com/top/summary', '微博'],
  ['百度热搜榜', 'https://top.baidu.com/board?tab=realtime', '百度'],
  ['哔哩哔哩 · 热门', 'https://www.bilibili.com/v/popular/all', 'B站'],
  ['GitHub Trending', 'https://github.com/trending', 'GitHub'],
  ['Hacker News', 'https://news.ycombinator.com/', 'HN']
]

export const curatedProvider = defineProvider({
  id: 'curated',
  name: '精选',
  kind: 'board',
  home: '',
  async fetch() {
    return CURATED.map(([title, url, source], index) => ({
      id: 'curated:' + index,
      title,
      url,
      source
    }))
  }
})

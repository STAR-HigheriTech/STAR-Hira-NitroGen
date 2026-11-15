/**
 * notes.mjs —— 集锦 / 笔记域的**唯一真源**（跨 bundle、跨进程共享；纯数据 + 纯函数、零依赖）
 *
 * ── 为什么必须只有一处 ─────────────────────────────────────────────
 * 同一批常量此前散在三处、语义相同却各写一份：
 *   · `domain/domain-notes`（CJS）—— 卡片类型、引用正则、ref 档位；
 *   · `apps/app-main/plugins/panel-notes.*`（渲染侧 bundle）—— 卡片类型、面板分段、引用 URI 构造；
 *   · `apps/app-main/src/main/browser-window-assembly.js`（主进程）—— 默认集锦名。
 * 「两处各写一个字符串」的代价在本仓库反复出现过：改名时只改一边，结果就是
 * 「右键收进去了、面板里却看不到」这类**静默不一致**。故与 reading-list.mjs / split-layout.mjs
 * 同一手法：**跨 bundle / 跨进程共用的常量一律下沉到 shared-types**。
 *
 * ⚠ 本文件必须保持「纯数据 + 纯函数、零依赖」：它同时被 Node（域层 `require`）与浏览器
 *   （面板 `import`）加载，一旦引入 electron / drizzle / 任何 infra 依赖，就会在其中一端炸掉。
 */

// 导出的 HTML 是**独立文档**（无外壳令牌）→ 直接取唯一字体栈的字面值。
import { UI_FONT_STACK, UI_MONO_STACK } from './font-stack.js'

/**
 * 卡片类型（集锦的**身份**）。
 *   note    —— 普通文字笔记（老数据默认就是它）
 *   page    —— 抓取的网页卡片（带来源 URL，可在同一文件夹内按 url 去重）
 *   image   —— 图片卡片（asset_* 承载落盘资产与缩略图）
 *   snippet —— 网页片段卡片（正文摘录）
 *   ref     —— 引用卡片（ref_id 指向另一张卡，形成一条 note_refs 边）
 */
const NOTE_KINDS = ['note', 'page', 'image', 'snippet', 'ref']

/** 卡片类型 → 中文名（面板筛选下拉 / 卡片副标题共用；别处不得再写第二种译法）。 */
/** @type {Record<string, string>} */
const NOTE_KIND_LABELS: Record<string, string> = { note: '笔记', page: '网页', image: '图片', snippet: '片段', ref: '引用' }

/**
 * 引用卡的展示形态（`ref_mode`）。
 *   chip   —— 一行引用（图标 + 目标标题）
 *   link   —— 链接式
 *   inline —— 把目标内容**只读**地嵌进来
 */
const REF_MODES = ['chip', 'link', 'inline']

/**
 * 面板的分段（IA 的取值集合，**顺序即 rail 上从左到右的顺序**）。
 *   collections —— 集锦卡片墙 + 进入后的卡片板
 *   all         —— 全部卡片平铺（跨集锦）
 *   reading     —— 「稍后读」清单（独立泳道，不许被集锦吸收）
 *   archive     —— 被收起的标签归档
 *   trash       —— 回收站
 */
const NOTE_SECTIONS = ['collections', 'all', 'reading', 'archive', 'trash']

/** 归一化分段取值：手改 / 未知字符串一律回落 `'all'`（"全部"是最中性的落点）。 */
/** @param {unknown} value @returns {string} */
function normalizeNoteSection(value: unknown) {
  const v = String(value == null ? '' : value)
  return NOTE_SECTIONS.includes(v) ? v : 'all'
}

// ── 图片资产基础设施的常量（**唯一真源**）──────────────────────────────
// 为什么放这里：主进程落盘（notes-assets.js）与面板读回（asset-thumb 的入参语义）
// 必须对"目录叫啥、缩略图多大、多大算大图"这些口径**逐字一致**；
// 与 NOTE_KINDS 同一理由 —— 两处各写一个字符串，
// 改一处漏一处就是"右键收进去了、面板里却看不到图"这类静默不一致。
//
// ⚠ 这里曾有一个 DEFAULT_COLLECTION_NAME（"没选集锦就自动建一个默认集锦"）。
// 它已随"收进哪里由用户显式选择（未归档 / 某个集锦）"而废弃：**没有隐式默认集锦**了，
// 未指定就是未归档（`folderId: null`）。故整个常量已删除，不要再引进隐式落点。

/**
 * 图片资产落盘根目录名（相对该 profile 的数据目录）：
 * `<userData>/profiles/<profileId>/notes-assets/`。
 * 与业务库同在一个 profile 目录下 —— 资产随 profile 隔离、随档案导出搬走。
 */
const NOTES_ASSETS_DIR = 'notes-assets'
/** 缩略图子目录名（`notes-assets/thumbs/`）—— 列表/封面只读这里的小图。 */
const NOTES_ASSET_THUMBS_DIR = 'thumbs'
/**
 * **落原图**的体积阈值（4MB）。
 * 超过它只保留缩略图、不落原图 —— 集锦是"收集"，不是图床：
 * 一条 20MB 的高清图留在 userData 里，用户既看不到原图（面板只画缩略图），
 * 又白白吃掉磁盘、还被档案导出整包搬走。**大图纪律**见 notes-assets.js。
 */
const NOTES_ASSET_MAX_BYTES = 4 * 1024 * 1024
/**
 * **抓取**的体积上限（16MB）—— 与上面的"落原图阈值"是两件事。
 * 超过它连缩略图都不生成（直接把这次抓取判失败）：缩略图要先把整张图解码进内存，
 * 无上限地下载一张 200MB 的图，代价是主进程内存被瞬间打满。
 */
const NOTES_ASSET_HARD_MAX_BYTES = 16 * 1024 * 1024
/** 缩略图目标宽度（px，等比缩放）—— 列表里最多显示 64px、编辑器里大一点，128 足够清晰。 */
const NOTES_ASSET_THUMB_WIDTH = 128

/**
 * **网页卡缩略图**的目标宽度（px，等比缩放）。
 *
 * 为什么与图片卡的 `NOTES_ASSET_THUMB_WIDTH`（128）分开：两者是**两种图**——
 *   · 图片缩略图是"原图的缩小版"，看的是像素细节，128 够；
 *   · 网页缩略图是"一整页的俯瞰"，缩到 128 会把版面压成一片糊，根本认不出是哪一页。
 * 而卡片预览区的宽度在宽松档可达 420px，故取 320：够看清版面骨架，又不至于让
 * 每张卡的 dataURL 大到拖慢列表（jpeg/png 一张约十几 KB）。
 */
const NOTES_PAGE_THUMB_WIDTH = 320

/**
 * 卡片**预览区**高度（px）—— 网页缩略图 / 图片卡预览的固定高度（`object-fit: cover`）。
 * 面板是窄侧栏，预览区高度必须**固定**（否则一堆卡片的预览高矮不一会把列表扫读节奏打乱）。
 * 容器查询三档会在窄档压矮、宽档加高，那两个数值是面板 CSS 的事，这里是"标准档"的口径。
 */
const NOTES_PREVIEW_HEIGHT = 96

/**
 * 集锦**导出到文件**支持的格式枚举（面板 ⋯ 菜单三选 / 主进程对话框 filters 共用）。
 * 取值即文件扩展名，`md` / `html` / `json` 各自对应一套面板侧序列化纯函数。
 */
const NOTE_EXPORT_FORMATS = ['md', 'html', 'json']

/**
 * 面板列表**一次性建卡的上限**（超过则先渲染前 N 张 + 一个「显示全部（N）」按钮）。
 *
 * 为什么要有这个数：卡片是**三段式**（预览区 + 两行元信息 + 注释便签），比一行文字重得多，
 * 每张还各自挂若干事件监听。几百上千张一次性建出来，首次重画会出现肉眼可见的卡顿
 * （建 DOM + 布局 + 首屏外缩略图全部发起 IPC）。
 *
 * 为什么取 300：窄侧栏一屏约 6 张卡，300 张 ≈ 50 屏，远超任何人手滚动的耐心 ——
 * 到那个量级，"先给一个按钮"比"卡一下再显示"体感更好，且用户点「显示全部」才付出代价。
 *
 * 放 shared-types 是照 NOTES_PREVIEW_HEIGHT 的先例：它是**体验口径**（不只是一处面板细节），
 * 以后若有第二个列表视图（例如某个插件窗口）也该用同一个数。
 */
const NOTES_LIST_RENDER_LIMIT = 300

/**
 * 引用 URI 的**唯一真源**。
 * 构造在渲染层（「复制引用」写剪贴板）、解析在领域层（从正文抽边表）——
 * 两处必须是**同一个 scheme 与同一套 id 字符集**，否则正文里的引用会**静默解析不到**
 * （反链就丢了：不报错、只是没有）。
 */
const REF_URI_SCHEME = 'hira-note://'
/** id 字符集与 `shared-utils#generateId` 的产物一致（字母 / 数字 / 下划线）。 */
const REF_ID_PATTERN = '[A-Za-z0-9_]+'
const REF_URI_RE = new RegExp(
  REF_URI_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(${REF_ID_PATTERN})`,
  'g'
)

/**
 * 笔记正文内联图片的资产 URI 方案（**唯一真源**）。
 *
 * 正文里**绝不写 dataURL**：一张图动辄几 MB，全部塞进正文会把库撑爆、把每次
 * `note:list` 的载荷拖垮。这里只写一个指向 userData 下资产文件的短 URI，
 * 预览时由面板向主进程换 dataURL（见 notes-assets.js#readThumb 的 LRU）。
 *
 * 构造（粘贴图片写入正文）与解析（Markdown 预览换图 / 导出换算）必须共用
 * 同一个 scheme —— 各写一份的结果是"写进去的图预览不出来"，不报错、只是静默丢图。
 */
const ASSET_URI_SCHEME = 'hira-asset:'

/**
 * 资产相对路径 → 正文内可写的 URI（空路径回空串，调用方据此放弃插入）。
 * @param {string} path 库里的 `assetPath` / `thumbPath`（相对 userData）
 * @returns {string}
 */
function noteAssetUri(path: string) : string {
  const p = String(path == null ? '' : path).trim()
  return p ? ASSET_URI_SCHEME + encodeURIComponent(p) : ''
}

/**
 * 正文里的资产 URI → 相对路径（不是该 scheme / 解码失败 → null）。
 * @param {unknown} src
 * @returns {string|null}
 */
function parseNoteAssetUri(src: unknown) : string|null {
  const s = String(src == null ? '' : src)
  if (!s.startsWith(ASSET_URI_SCHEME)) return null
  try {
    const p = decodeURIComponent(s.slice(ASSET_URI_SCHEME.length))
    return p || null
  } catch (_) {
    return null
  }
}

/**
 * 编辑器里输入 `@` 触发内联引用补全时，**候选条数上限**。
 * 放这里而不是面板里：它是"引用体验"的一条口径（Notion / 飞书同款手感），
 * 面板只是消费它；以后若有第二个入口（例如命令面板的 `@`）也必须是同一个数。
 */
const NOTE_MENTION_LIMIT = 8

/**
 * 构造一条引用 URI。
 * @param {string} id
 * @returns {string}
 */
function noteRefUri(id: string) : string {
  return REF_URI_SCHEME + String(id == null ? '' : id)
}

/**
 * 从一段正文里抽出被引用的 id（**去重**，保持出现顺序）。
 * @param {string} text
 * @returns {string[]}
 */
function parseNoteRefUris(text: string) : string[] {
  const src = String(text == null ? '' : text)
  const seen = new Set()
  const out = []
  REF_URI_RE.lastIndex = 0
  let m
  while ((m = REF_URI_RE.exec(src)) !== null) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push(m[1])
  }
  return out
}

/**
 * 把一段文本按「引用 URI」切成片段，供**渲染层**把 `hira-note://<id>` 原地换成可点 chip：
 * 返回 `[{ text } | { refId }]` 交替的数组（顺序即原文顺序）。
 *
 * 为什么在这里而不是让渲染层再写一个正则：`parseNoteRefUris`（抽 id 写边表）与
 * 这个（切片段画 chip）必须落在**同一个 id 字符集**上 —— 各写一份正则的结果是
 * "能画出来的 chip 解析不出边、能解析出边的画不出来"，那种不一致不报错、只是静默丢功能。
 * 两者共用同一个 `REF_URI_RE`，故不可能漂移。
 * @param {string} text
 * @returns {Array<{ text: string } | { refId: string }>}
 */
function splitNoteRefs(text: string) : Array<{ text: string } | { refId: string }> {
  const src = String(text == null ? '' : text)
  /** @type {Array<{ text: string } | { refId: string }>} */
  const out: Array<{ text: string } | { refId: string }> = []
  let last = 0
  REF_URI_RE.lastIndex = 0
  let m
  while ((m = REF_URI_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) })
    out.push({ refId: m[1] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ text: src.slice(last) })
  return out
}

// ── 「选取文字 → 收藏成一条 note」的文本基础设施（**唯一真源**）───────────
//
// 为什么这两件事非要下沉到 shared-types：
//   · `buildSourceNoteContent` 的产物要**落库**（主进程右键路径写、面板读）；
//   · `buildTextFragmentUrl` 既在主进程构造（存进卡片 url），又被面板用来判断
//     「这个链接是不是能跳到原文选中处」（决定按钮文案）。两处各写一套模板 / 各写一个
//     `#:~:text=` 字面量，改一处漏一处就是「卡片上写着能跳、点了却只普通打开」这类静默不一致
//     —— 与 NOTE_KINDS / REF_URI_SCHEME 同一条教训。

/**
 * Scroll-to-Text-Fragment 指令的**唯一标记**（`#:~:text=`）。
 * 构 URL 的（buildTextFragmentUrl）与判「是不是定位链接」的（面板 / 主进程）共用它，
 * 免得各写一份字面量。
 */
const TEXT_FRAGMENT_MARKER = ':~:text='

/**
 * 把「页面标题 + 完整 URL + 摘录文字」拼成一条 note 的**正文模板**（唯一真源）。
 *
 * 产物形如（三段，段间空行）：
 *   ```
 *   # 页面标题
 *
 *   [https://example.com/a](https://example.com/a)
 *
 *   > 摘录的所选文字
 *   ```
 *
 * ── 为什么把标题与完整 URL 都写进正文（而不是只在卡片的 url 字段里留一份）──────
 * 这段正文会被**复制 / 导出**到别处（邮件、文档、剪贴板）：一离开本应用，卡片的 url 字段
 * 就看不到了。所以正文必须**自带出处** —— 脱离浏览器也一眼知道「这是从哪一页摘的」。
 * （卡片上真正用于跳转的是另一个「带 text fragment 的 URL」，两个 URL 分工见
 *  buildTextFragmentUrl 的注释。）
 *
 * ── 为什么用「空行分段」而不是单个换行 ────────────────────────────────
 * 标准 Markdown 会把段落内的单个换行**折叠成空格**（作者软换行）；只有**空行**才切块。
 * 故标题 / URL / 摘录之间一律空行 —— 否则预览里三段会挤成一坨。标题用 `# ` 是让它在
 * 源码与预览里都明确"这是页面标题"；摘录用行首 `> ` 是引用块语法（"这段是摘来的"）。
 * 正文里**不放**「来源：」这类多余前缀（出处已由标题与 URL 本身表达）。
 *
 * @param {{ title?: string, url?: string, text?: string }} [input]
 * @returns {string}
 */
function buildSourceNoteContent(
  { title, url, text }: { title?: string; url?: string; text?: string } = {}
): string {
  const heading = String(title == null ? '' : title).trim()
  const link = String(url == null ? '' : url).trim()
  // 统一换行（Windows 选区可能带回 `\r\n`）—— 否则逐行前置 `> ` 时行尾会残留 `\r`。
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  /** @type {string[]} */
  const blocks: string[] = []
  if (heading) blocks.push(`# ${heading}`)
  // 裸 URL 不会被本应用的 Markdown 渲染器自动转链接 —— 写成 `[url](url)` 才在预览里可点。
  if (link) blocks.push(`[${link}](${link})`)
  if (body) {
    // 摘录逐行前置 `> `（空行写成 `>`）—— 保住多行摘录整块落在同一个引用块里。
    blocks.push(body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'))
  }
  return blocks.join('\n\n')
}

/**
 * 构造「带 Scroll-to-Text-Fragment 的定位 URL」—— 用于「点来源 → 直接滚到/高亮所选文字」。
 *
 * ── 为什么用它 ────────────────────────────────────────────────────────
 * text fragment（`#:~:text=...`）是 **Chromium 原生**能力（Electron 直接支持、自带高亮），
 * 零基础设施、零自绘高亮。不支持该特性的环境（旧核心 / 别的浏览器）只会**普通打开**该页
 * —— 优雅退化，不会报错、不会跳错。
 *
 * ── 为什么存进卡片的 url 字段、而正文里写干净 URL（**两个 URL 分工，别"统一"掉**）──
 *   · 卡片 `url` 字段 = **带 text fragment 的定位 URL** → 供「跳到原文那段」用；
 *   · 正文里的 URL    = **干净 URL（不带 fragment）** → 供阅读 / 复制 / 导出用。
 * 两者各司其职：正文里的链接给人看、给人复制，带上 `#:~:text=` 既丑又会在别处失效；
 * 而跳转要的是能定位。谁哪天想"统一成一个"，就会让这两件中的一件坏掉。
 *
 * ── 截取规则（务实：只取一段"绝对不用转义"的开头）──────────────────────
 * text fragment 里 `-` `&` `,` 是**结构性字符**，作为字面量出现时按规范要前置 `-` 转义。
 * 与其实现整套转义，这里**从开头截到第一个这类字符为止**（那个字符本身丢弃），
 * 保证选出来的子串天然不含需转义字符；再限长 60 字（够唯一定位，又不至于把 URL 撑很长），
 * 最后 percent-encode（`encodeURIComponent`）。
 * 选不出可用子串（原文以这类字符开头 / 全空白）时**原样返回 url** —— 退化成普通打开。
 *
 * @param {string} url 原始 URL（可能已带自己的 `#fragment`）
 * @param {string} text 所选文字
 * @returns {string} 定位 URL（无法构造时 = 原 url）
 */
function buildTextFragmentUrl(url: string, text: string) : string {
  const raw = String(url == null ? '' : url).trim()
  if (!raw) return raw
  // 换行 / 连续空白归一成单空格：fragment 的匹配文本里不该带换行。
  const normalized = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!normalized) return raw
  const cut = normalized.search(/[-&,]/)
  const head = (cut >= 0 ? normalized.slice(0, cut) : normalized).trim()
  if (!head) return raw
  const picked = head.slice(0, 60)
  if (!picked) return raw
  const encoded = encodeURIComponent(picked)
  // 原 URL 已有 fragment：按规范把 text 指令**续在原 fragment 之后** → `#原frag:~:text=...`。
  const hashIndex = raw.indexOf('#')
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const existing = hashIndex >= 0 ? raw.slice(hashIndex + 1) : ''
  return existing
    ? `${base}#${existing}${TEXT_FRAGMENT_MARKER}${encoded}`
    : `${base}#${TEXT_FRAGMENT_MARKER}${encoded}`
}

// ── 卡片展示 / 导出的纯函数（**唯一真源**）──────────────────────────────
//
// 这些函数原先只存在于面板 bundle（panel-notes.model.js / panel-notes.markdown.js）。
// 现在主进程也要产出同一份「标题 / 纯文本 / Markdown / HTML / JSON」——
// 命令链、快捷键、右键菜单都在主进程侧执行 `note:copy-all` / `note:export`，
// 而面板里的「复制全部 / 导出」仍走渲染侧。**两处各写一份序列化**的后果是
// 同一份集锦从面板导出与从命令导出内容不一致（缩进、标题兜底、URL 取舍都可能漂移）。
// 故按 NOTE_KINDS 的同一条教训下沉到这里：面板侧改为 re-export，不再保留本地实现。

/**
 * 提取纯文本摘要（列表行预览 / 导出正文用）——去掉 Markdown 标记，压成一行。
 * @param {unknown} src
 * @param {number} [max]
 * @returns {string}
 */
function plainTextSnippet(src: unknown, max: number = 140) : string {
  const text = String(src == null ? '' : src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 归一化卡片类型（脏数据一律落 'note'）。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeNoteKind(value: unknown) : string {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value) ? value : 'note'
}

/**
 * 列表里显示的名字：显式标题优先，否则取正文首行的纯文本 —— Vivaldi 同款行为，
 * 且**不回写**数据库（"看着像标题"和"真的是标题"是两件事，混起来会污染用户数据）。
 *
 * 例外 · 划词卡（kind='snippet'）：**优先用来源页标题（sourceTitle）**——
 * 标题行表达"这是从哪一页摘的"，摘录文字摊在预览区，避免两处重复同一段文字。
 *
 * @param {{ title?: string, content?: string, kind?: string, sourceTitle?: string }} note
 * @returns {string}
 */
function displayNoteTitle(note: { title?: string, content?: string, kind?: string, sourceTitle?: string }) : string {
  const kind = normalizeNoteKind(note && note.kind)
  if (kind === 'snippet') {
    const src = String((note && note.sourceTitle) || '').trim()
    if (src) return src
  }
  const title = String((note && note.title) || '').trim()
  if (title) return title
  const first = plainTextSnippet(note && note.content, 60)
  if (first) return first
  // 空标题按卡片类型给一个兜底名字（图片卡叫「图片」比「未命名笔记」更贴切）。
  return kind === 'note' ? '未命名笔记' : (NOTE_KIND_LABELS[kind as keyof typeof NOTE_KIND_LABELS] || '未命名笔记')
}

/**
 * 把一组卡片拼成可粘进邮件的**纯文本**（集锦级「复制全部」）。
 * 备注卡输出正文（去掉 Markdown 标记），其余输出「标题 — URL」。
 * @param {Array<any>} notes
 * @returns {string}
 */
interface NoteExportItem {
  title?: string
  content?: string
  kind?: string
  sourceTitle?: string
  url?: string
  tags?: unknown[]
  assetPath?: string
  thumbPath?: string
  assetWidth?: number
  assetHeight?: number
  createdAt?: number
  modifiedAt?: number
  sortOrder?: number
  [key: string]: unknown
}

function notesToPlainText(notes: readonly NoteExportItem[]): string {
  const lines: string[] = []
  for (const n of Array.isArray(notes) ? notes : []) {
    const title = displayNoteTitle(n)
    if (n && n.kind === 'note') {
      const body = plainTextSnippet(n.content, 1000)
      lines.push(body ? `${title}\n${body}` : title)
    } else if (n && n.kind === 'ref') {
      lines.push(`${title} → 引用`)
    } else if (n && n.url) {
      lines.push(`${title} — ${n.url}`)
    } else {
      lines.push(title)
    }
  }
  return lines.join('\n')
}

/**
 * 把一组卡片拼成 **Markdown**。
 *
 * 两个调用点共用它（面板「复制为 Markdown」/「导出 → Markdown」与主进程的同名动作）。
 * 格式约定：一级标题（集锦名）+ 逐卡一行 `- [标题](url)`；备注 / 片段再把正文
 * 以**引用块**（`> `）缀在其下 —— 引用块在 Markdown 渲染器里天然是"附在条目下的细节"。
 * @param {Array<any>} notes
 * @param {string} [heading] 集锦名，作为一级标题
 * @returns {string}
 */
function notesToMarkdown(notes: readonly NoteExportItem[], heading: string): string {
  const out: string[] = []
  if (heading) out.push(`# ${String(heading)}`, '')
  for (const n of Array.isArray(notes) ? notes : []) {
    const title = displayNoteTitle(n)
    const kind = normalizeNoteKind(n && n.kind)
    if (kind === 'page' && n.url) out.push(`- [${title}](${n.url})`)
    else if (kind === 'image') out.push(`- ${title}${n.url ? ` ([来源](${n.url}))` : ''}`)
    else if (kind === 'ref') out.push(`- ${title}（引用）`)
    else if (kind === 'snippet') out.push(`- ${title}${n.url ? ` ([来源](${n.url}))` : ''}`, `  > ${plainTextSnippet(n.content, 200)}`)
    else out.push(`- ${title}`, '', String(n.content || '').trim(), '')
  }
  return out.join('\n').trim()
}

/** HTML 导出里的转义（内容是用户文本，绝不能当标记拼进去）。 */
/** @param {unknown} value @returns {string} */
function escapeExportHtml(value: unknown) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c
  ))
}

/**
 * 把一组卡片拼成**最小可读的 HTML**（「导出 → HTML」）。
 *
 * 一份自包含的静态文档（内联极简样式，无外部依赖）：一个可选 `<h1>` + 一个 `<ul>`。
 * 刻意**不**追求样式精美：导出物的目的是"拿得走、打得开、看得见内容"。
 * @param {Array<any>} notes
 * @param {string} [heading]
 * @returns {string}
 */
function notesToHtml(notes: readonly NoteExportItem[], heading: string): string {
  const parts = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeExportHtml(heading || '集锦')}</title>`,
    '<style>',
    `body{font:14px/1.6 ${UI_FONT_STACK};max-width:760px;margin:24px auto;padding:0 16px;color:#1a1a1a}`,
    'h1{font-size:20px}ul{padding-left:20px}li{margin:8px 0}',
    `pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;padding:8px 10px;border-radius:6px;font-family:${UI_MONO_STACK};font-size:12.5px}`,
    'a{color:#2563eb}',
    '</style>',
    '</head>',
    '<body>'
  ]
  if (heading) parts.push(`<h1>${escapeExportHtml(heading)}</h1>`)
  parts.push('<ul>')
  for (const n of Array.isArray(notes) ? notes : []) {
    const title = escapeExportHtml(displayNoteTitle(n))
    const kind = normalizeNoteKind(n && n.kind)
    const label = n && n.url
      ? `<a href="${escapeExportHtml(n.url)}" rel="noreferrer noopener">${title}</a>`
      : title
    const bodyText = (kind === 'note' || kind === 'snippet') ? String(n.content || '').trim() : ''
    parts.push(bodyText
      ? `<li>${label}<pre>${escapeExportHtml(bodyText)}</pre></li>`
      : `<li>${label}</li>`)
  }
  parts.push('</ul>', '</body>', '</html>')
  return parts.join('\n')
}

/**
 * 把一组卡片拼成 **JSON**（「导出 → JSON」）。
 *
 * 一个**卡片数组**，每项只保留"别的程序真会用到的字段"——不是数据库转储
 * （`profileId` / `sortOrder` / `deletedAt` 这类实现细节不导出）。
 * 顶层保持数组而非 `{ name, exportedAt, cards }`：集锦名交给文件名。
 * @param {Array<any>} notes
 * @param {string} [_heading] 集锦名（数组形态用不到，保留签名与另两种一致）
 * @returns {string}
 */
function notesToJson(notes: readonly NoteExportItem[], _heading: string): string {
  const cards = (Array.isArray(notes) ? notes : []).map((n) => ({
    kind: normalizeNoteKind(n && n.kind),
    title: displayNoteTitle(n),
    url: (n && n.url) || null,
    content: String((n && n.content) || ''),
    sourceTitle: (n && n.sourceTitle) || null,
    tags: Array.isArray(n && n.tags) ? n.tags : [],
    assetPath: (n && n.assetPath) || null,
    thumbPath: (n && n.thumbPath) || null,
    assetWidth: (n && n.assetWidth) || 0,
    assetHeight: (n && n.assetHeight) || 0,
    createdAt: (n && n.createdAt) || 0,
    modifiedAt: (n && n.modifiedAt) || 0
  }))
  return JSON.stringify(cards, null, 2)
}

/**
 * 导出格式 id → 序列化函数（面板与主进程共用同一张表；新增格式只改这里）。
 * 这就是 `note.export-format` 插槽的**内置实现基线**（WP3）。
 */
const NOTE_EXPORT_SERIALIZERS: Readonly<Record<string, (notes: readonly NoteExportItem[], heading: string) => string>> = Object.freeze({
  md: notesToMarkdown,
  html: notesToHtml,
  json: notesToJson
})

/**
 * 按格式 id 序列化一组卡片（未知格式回落纯文本，不抛错）。
 * @param {Array<any>} notes
 * @param {string} format
 * @param {string} [heading]
 * @returns {string}
 */
function serializeNotes(notes: readonly NoteExportItem[], format: string, heading: string): string {
  const fn = NOTE_EXPORT_SERIALIZERS[String(format || '')]
  return fn ? fn(notes, heading) : notesToPlainText(notes)
}

// ── 排序（面板与主进程动作共用同一口径）────────────────────────────────

/**
 * 卡片的时间戳（毫秒）：优先修改时间，其次创建时间。
 * @param {any} note
 * @returns {number}
 */
function noteTimeValue(note: unknown) : number {
  const source = note && typeof note === 'object' ? note as Record<string, unknown> : {}
  return Number(source.modifiedAt || source.createdAt || 0) || 0
}

/**
 * 列表展示顺序：手动排序优先，其次新→旧。
 *
 * 这是「面板里看到的顺序」与「主进程 note:open-all / note:copy-all / note:export
 * 拿到的顺序」**唯一**的定义 —— 两处各写一份比较器，迟早出现"面板显示 1,2,3、
 * 全选打开却按 3,2,1"这种不可解释的差异。
 *
 * @param {Array<any>} notes
 * @returns {Array<any>} 新数组（不改入参）
 */
function sortNotesForDisplay(notes: readonly NoteExportItem[]): NoteExportItem[] {
  return (Array.isArray(notes) ? notes.slice() : [])
    .sort((a, b) => ((a && a.sortOrder) || 0) - ((b && b.sortOrder) || 0) || noteTimeValue(b) - noteTimeValue(a))
}

export {
  NOTE_KINDS,
  NOTE_KIND_LABELS,
  REF_MODES,
  NOTE_SECTIONS,
  normalizeNoteSection,
  plainTextSnippet,
  normalizeNoteKind,
  displayNoteTitle,
  notesToPlainText,
  notesToMarkdown,
  notesToHtml,
  notesToJson,
  NOTE_EXPORT_SERIALIZERS,
  serializeNotes,
  noteTimeValue,
  sortNotesForDisplay,
  NOTES_ASSETS_DIR,
  NOTES_ASSET_THUMBS_DIR,
  NOTES_ASSET_MAX_BYTES,
  NOTES_ASSET_HARD_MAX_BYTES,
  NOTES_ASSET_THUMB_WIDTH,
  NOTES_PAGE_THUMB_WIDTH,
  NOTES_PREVIEW_HEIGHT,
  NOTES_LIST_RENDER_LIMIT,
  NOTE_EXPORT_FORMATS,
  REF_URI_SCHEME,
  noteAssetUri,
  parseNoteAssetUri,
  NOTE_MENTION_LIMIT,
  noteRefUri,
  parseNoteRefUris,
  splitNoteRefs,
  TEXT_FRAGMENT_MARKER,
  buildSourceNoteContent,
  buildTextFragmentUrl
}

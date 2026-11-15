/**
 * 集锦「Office 导出」—— `note.export-format` 插槽的**官方参考实现**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════
 * 往集锦 ⋯ → 导出 的子菜单里补两项：`.xlsx` / `.docx`。两者都是 OOXML 容器
 * （一个 ZIP 里放几份 XML），所以整个文件**零依赖**：
 *   · ZIP 写入器（store 存储法 + CRC32 + 中央目录）在本文件内 ~100 行；
 *   · XLSX / DOCX 各自只要 3–5 份最小 XML 就能被 Excel / Word / WPS 打开。
 * 不引入任何第三方库（含 fflate / xlsx / docx）—— 插件跑在面板渲染进程里，
 * 多一个依赖就多一份要跨进程加载、要随插件分发的体积。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么序列化在这里，而不是主进程
 * ══════════════════════════════════════════════════════════════════════
 * 插槽契约就是这样分工的：
 *   · **插件**最懂自己的格式 → `serialize(cards, name)` 产出内容；
 *   · **宿主**只负责落盘（弹保存框、按扩展名建 filter、写字节）。
 * `encoding: 'base64'` 是本插件与宿主约定的字节语义：serialize 返回 base64，
 * 主进程解码成 Buffer 后原样写盘（见 notes-export-file.js）。
 * 于是文本格式（md/html/json）与二进制格式走的是**同一条**落盘通道，
 * 主进程不需要认识"xlsx 长什么样"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 对第三方插件作者的示意
 * ══════════════════════════════════════════════════════════════════════
 * 贡献一个新导出格式只需要三件事：
 *   1. manifest 写 `"render": "./xxx.renderer.js"`，并在
 *      `"contributes": { "rendererSlots": ["note.export-format"] }` 里**登记这个槽** ——
 *      非面板窗口只按这份登记决定要不要 import 渲染模块（见 plugin-slots.js）；
 *   2. 模块导出 `rendererPlugin.slots['note.export-format']`，返回 provider 数组
 *      （或单个 provider）；
 *   3. provider = `{ id, label, extension, serialize(cards, name), encoding? }`。
 * 卡片字段见 packages/shared-types/src/notes.mjs 的 `notesToJson`。
 */

import { displayNoteTitle, normalizeNoteKind, NOTE_KIND_LABELS } from '@hira-ng/shared-types/src/notes.mjs'
import type { Note } from '@hira-ng/domain-notes'

interface DocxRunOptions {
  bold?: boolean
  size?: number
  color?: string
  before?: number
  after?: number
}

// ══════════════════════════════════════════════════════════════════════
// XML 基础
// ══════════════════════════════════════════════════════════════════════

/**
 * XML 文本节点转义。
 *
 * 另删掉 XML 1.0 不允许的控制字符：用户正文里粘进一个 `\u0000` 或 `\u000B`，
 * 整个 word/document.xml 就会变成"文件已损坏"——这是最容易漏、也最难查的一类。
 */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
function xmlText(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(XML_ILLEGAL, '')
    .replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] || c
    ))
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** 毫秒时间戳 → `YYYY-MM-DD HH:mm`（本地时区，导出物给人看）。 */
function formatTime(value: unknown): string {
  const ms = Number(value) || 0
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 卡片 → 导出行/段落共用的归一化视图（两种格式看到同一份数据）。 */
function toRow(note: Note, index: number) {
  const kind = normalizeNoteKind(note && note.kind)
  const tags = Array.isArray(note && note.tags) ? note.tags.filter(Boolean).map(String) : []
  return {
    index: index + 1,
    kind,
    kindLabel: (NOTE_KIND_LABELS as Record<string, string>)[kind] || kind,
    title: displayNoteTitle({
      title: note.title,
      content: note.content,
      kind: note.kind,
      sourceTitle: note.sourceTitle ?? undefined
    }),
    url: String((note && note.url) || ''),
    content: String((note && note.content) || ''),
    tags: tags.join(' / '),
    sourceTitle: String((note && note.sourceTitle) || ''),
    createdAt: formatTime(note && note.createdAt),
    modifiedAt: formatTime(note && note.modifiedAt)
  }
}

// ══════════════════════════════════════════════════════════════════════
// ZIP 写入器（store，不压缩）
// ══════════════════════════════════════════════════════════════════════
//
// 为什么自己写而不是用 CompressionStream：
//   · `deflate-raw` 在旧版 Electron 里不一定有；
//   · 导出物是几 KB–几 MB 的 XML，store 的体积代价可以接受，
//     换来的是"任何环境都能确定性地产出同一个包"。
// 结构就是规范里那三段：本地头 + 数据、中央目录、EOCD。

/** CRC32 查表（IEEE 802.3，ZIP 用的就是这个多项式）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 一次构建的 DOS 时间/日期（同一包内所有条目一致 —— 也让产物可复现）。 */
function dosStamp(date: Date): { time: number; day: number } {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F)
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  return { time, day }
}

const ZIP_FLAG_UTF8 = 0x0800

/**
 * @param {Array<{ name: string, xml: string }>} files
 * @returns {Uint8Array}
 */
function zipStore(files: Array<{ name: string, xml: string }>) : Uint8Array {
  const encoder = new TextEncoder()
  const stamp = dosStamp(new Date())
  /** @type {Uint8Array[]} */
  const chunks: Uint8Array[] = []
  /** @type {Array<{ name: Uint8Array, crc: number, size: number, offset: number }>} */
  const entries: Array<{ name: Uint8Array, crc: number, size: number, offset: number }> = []
  let offset = 0

  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.xml)
    const crc = crc32(data)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)
    lv.setUint16(4, 20, true)              // version needed
    lv.setUint16(6, ZIP_FLAG_UTF8, true)   // 文件名是 UTF-8
    lv.setUint16(8, 0, true)               // method: store
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.day, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)              // extra length
    local.set(name, 30)

    chunks.push(local, data)
    entries.push({ name, crc, size: data.length, offset })
    offset += local.length + data.length
  }

  const centralStart = offset
  let centralSize = 0
  for (const entry of entries) {
    const head = new Uint8Array(46 + entry.name.length)
    const dv = new DataView(head.buffer)
    dv.setUint32(0, 0x02014B50, true)
    dv.setUint16(4, 20, true)              // version made by
    dv.setUint16(6, 20, true)              // version needed
    dv.setUint16(8, ZIP_FLAG_UTF8, true)
    dv.setUint16(10, 0, true)              // method: store
    dv.setUint16(12, stamp.time, true)
    dv.setUint16(14, stamp.day, true)
    dv.setUint32(16, entry.crc, true)
    dv.setUint32(20, entry.size, true)
    dv.setUint32(24, entry.size, true)
    dv.setUint16(28, entry.name.length, true)
    dv.setUint16(30, 0, true)              // extra
    dv.setUint16(32, 0, true)              // comment
    dv.setUint16(34, 0, true)              // disk start
    dv.setUint16(36, 0, true)              // internal attrs
    dv.setUint32(38, 0, true)              // external attrs
    dv.setUint32(42, entry.offset, true)
    head.set(entry.name, 46)
    chunks.push(head)
    centralSize += head.length
  }

  const eocd = new Uint8Array(22)
  const dv = new DataView(eocd.buffer)
  dv.setUint32(0, 0x06054B50, true)
  dv.setUint16(4, 0, true)
  dv.setUint16(6, 0, true)
  dv.setUint16(8, entries.length, true)
  dv.setUint16(10, entries.length, true)
  dv.setUint32(12, centralSize, true)
  dv.setUint32(16, centralStart, true)
  dv.setUint16(20, 0, true)
  chunks.push(eocd)

  const total = chunks.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of chunks) { out.set(part, at); at += part.length }
  return out
}

/**
 * 字节 → base64。
 *
 * 分块是因为 `String.fromCharCode(...bytes)` 的参数个数上限（~64K）：
 * 一份几 MB 的 xlsx 直接展开会抛 `too many arguments`，这个坑只在大集锦上出现。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    for (const byte of bytes.subarray(i, i + CHUNK)) binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

// ══════════════════════════════════════════════════════════════════════
// XLSX（SpreadsheetML）
// ══════════════════════════════════════════════════════════════════════
//
// 最小可打开集合：content-types → 包关系 → workbook → workbook 关系 → sheet。
// 全部用 inlineStr（`<is><t>`）而不是 sharedStrings：少一份表、少一处索引维护，
// 对"导出一次就扔"的集锦来说是更合适的取舍。

const XLSX_HEADERS = ['类型', '标题', '链接', '正文', '标签', '来源', '创建时间', '修改时间']
const XLSX_COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/** 工作表名：Excel 限制 31 字符、且不许 `[]:*?/\\`；空名回落「集锦」。 */
function sheetName(name: unknown): string {
  const cleaned = String(name || '').replace(/[\\[\]*?:/]/g, '_').trim().slice(0, 31)
  return cleaned || '集锦'
}

function xlsxCell(ref: string, value: unknown): string {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`
}

function buildSheet(cards: Note[]): string {
  const rows = []
  rows.push(
    `<row r="1">${XLSX_HEADERS.map((h, i) => xlsxCell(`${XLSX_COL_LETTERS[i]}1`, h)).join('')}</row>`
  )
  cards.forEach((note, index) => {
    const row = toRow(note, index)
    const n = index + 2
    const values = [row.kindLabel, row.title, row.url, row.content, row.tags, row.sourceTitle, row.createdAt, row.modifiedAt]
    rows.push(`<row r="${n}">${values.map((v, i) => xlsxCell(`${XLSX_COL_LETTERS[i]}${n}`, v)).join('')}</row>`)
  })
  // 列宽按内容类型给（标题/正文最宽）；首行冻结，滚动时表头常驻。
  const cols = [
    '<cols>',
    '<col min="1" max="1" width="8" customWidth="1"/>',
    '<col min="2" max="2" width="32" customWidth="1"/>',
    '<col min="3" max="3" width="40" customWidth="1"/>',
    '<col min="4" max="4" width="60" customWidth="1"/>',
    '<col min="5" max="5" width="18" customWidth="1"/>',
    '<col min="6" max="6" width="24" customWidth="1"/>',
    '<col min="7" max="8" width="18" customWidth="1"/>',
    '</cols>'
  ].join('')
  return `${XML_DECL}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}
<sheetData>${rows.join('')}</sheetData>
</worksheet>`
}

function buildXlsx(cards: Note[], name: string): Uint8Array {
  const files = [
    {
      name: '[Content_Types].xml',
      xml: `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      xml: `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      xml: `${XML_DECL}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlText(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    },
    { name: 'xl/worksheets/sheet1.xml', xml: buildSheet(cards) }
  ]
  return zipStore(files)
}

// ══════════════════════════════════════════════════════════════════════
// DOCX（WordprocessingML）
// ══════════════════════════════════════════════════════════════════════
//
// 只放 document.xml（+ 包关系 + content-types）：没有 styles.xml / numbering.xml，
// 所有格式用 run 级直接属性表达（加粗、字号、颜色）—— 少三份 XML，
// 打开效果完全一致。链接也写成纯文本 URL：超链接要额外的 rels 表，
// 而"导出的 Word 里能不能点"远不如"内容完整、不乱码"重要。

/** 一个 run（可多行，内部用 `<w:br/>` 折行）。 */
function docxRun(text: string, { bold = false, size = 0, color = '' }: DocxRunOptions = {}): string {
  const props = []
  if (bold) props.push('<w:b/>')
  if (size) props.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`)
  if (color) props.push(`<w:color w:val="${color}"/>`)
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const body = lines
    .map((line, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(line)}</w:t>`)
    .join('')
  return `<w:r>${rPr}${body}</w:r>`
}

function docxParagraph(text: string, opts: DocxRunOptions = {}): string {
  const spacing = opts.before || opts.after
    ? `<w:pPr><w:spacing${opts.before ? ` w:before="${opts.before}"` : ''}${opts.after ? ` w:after="${opts.after}"` : ''}/></w:pPr>`
    : ''
  return `<w:p>${spacing}${docxRun(text, opts)}</w:p>`
}

function buildDocument(cards: Note[], name: string): string {
  const parts = []
  parts.push(docxParagraph(name || '集锦', { bold: true, size: 36, after: 240 }))

  cards.forEach((note, index) => {
    const row = toRow(note, index)
    parts.push(docxParagraph(row.title, { bold: true, size: 24, before: index ? 200 : 0, after: 60 }))
    if (row.url) parts.push(docxParagraph(row.url, { size: 18, color: '2563EB' }))
    if (row.content.trim()) parts.push(docxParagraph(row.content, { size: 21 }))
    const meta = [row.kindLabel, row.tags && `标签：${row.tags}`, row.sourceTitle && `来源：${row.sourceTitle}`, row.createdAt && `创建：${row.createdAt}`]
      .filter(Boolean)
      .join('　·　')
    if (meta) parts.push(docxParagraph(meta, { size: 16, color: '808080', after: 120 }))
  })

  const body = parts.join('')
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
  return `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}${sectPr}</w:body>
</w:document>`
}

function buildDocx(cards: Note[], name: string): Uint8Array {
  const files = [
    {
      name: '[Content_Types].xml',
      xml: `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      xml: `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    },
    { name: 'word/document.xml', xml: buildDocument(cards, name) }
  ]
  return zipStore(files)
}

// ══════════════════════════════════════════════════════════════════════
// 插槽贡献
// ══════════════════════════════════════════════════════════════════════

/**
 * provider 契约（宿主侧消费见 panel-notes.model.js#exportCollection）：
 *   id         菜单动作里的稳定标识（`export-plugin:<id>`）
 *   label      子菜单文案
 *   extension  文件扩展名（同时也是保存框的 filter 键）
 *   encoding   `'base64'` 表示 serialize 返回 base64 字节串
 *   serialize  纯函数：卡片数组 + 集锦名 → 内容
 */
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'xlsx',
    label: '导出为 Excel（.xlsx）',
    extension: 'xlsx',
    encoding: 'base64',
    serialize: (cards: Note[], name: string) => bytesToBase64(buildXlsx(Array.isArray(cards) ? cards : [], name))
  }),
  Object.freeze({
    id: 'docx',
    label: '导出为 Word（.docx）',
    extension: 'docx',
    encoding: 'base64',
    serialize: (cards: Note[], name: string) => bytesToBase64(buildDocx(Array.isArray(cards) ? cards : [], name))
  })
])

export const rendererPlugin = {
  /**
   * MULTI 插槽：返回数组会被 `callRendererSlotMulti` 展平一层，
   * 于是"一个插件贡献多个格式"不需要任何额外协议。
   * 只在集锦级导出时提供（卡片级导出将来若有别的 scope，在这里分流即可）。
   */
  slots: {
    'note.export-format': (payload: unknown) => {
      const scope = payload && typeof payload === 'object'
        ? (payload as { scope?: unknown }).scope
        : null
      return scope && scope !== 'collection' ? [] : PROVIDERS
    }
  }
}

export default rendererPlugin

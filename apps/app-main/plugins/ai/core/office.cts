/** 本地 Office 文档读写（DOCX / XLSX / PPTX / PDF）。纯函数，不碰工作区与审批。 */

const path = require('path')
const zlib = require('zlib')
const { pathToFileURL } = require('url')

interface ZipEntry { name: string; data: Buffer | string }
interface OfficeSheet { name?: string; rows: unknown[][] }
interface OfficeSlide { title?: string; bullets?: unknown[] }

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
const MAX_ZIP_ENTRIES = 4096
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024

function xmlText(value: unknown): string {
  return String(value == null ? '' : value).replace(XML_ILLEGAL, '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] || c
  ))
}

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_m, entity: string) => {
    const key = entity.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    try {
      const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m
    } catch (_) { return _m }
  })
}

function textMatches(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) out.push(decodeXml(match[1].replace(/<[^>]+>/g, '')))
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function dosStamp(date: Date): { time: number; day: number } {
  return {
    time: ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F),
    day: (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  }
}

function zipStore(files: ZipEntry[]): Buffer {
  const stamp = dosStamp(new Date())
  const chunks: Buffer[] = []
  const entries: Array<{ name: Buffer; crc: number; size: number; offset: number }> = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    chunks.push(local, data)
    entries.push({ name, crc, size: data.length, offset })
    offset += local.length + data.length
  }
  const centralStart = offset
  let centralSize = 0
  for (const entry of entries) {
    const head = Buffer.alloc(46 + entry.name.length)
    head.writeUInt32LE(0x02014B50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(0, 10)
    head.writeUInt16LE(stamp.time, 12)
    head.writeUInt16LE(stamp.day, 14)
    head.writeUInt32LE(entry.crc, 16)
    head.writeUInt32LE(entry.size, 20)
    head.writeUInt32LE(entry.size, 24)
    head.writeUInt16LE(entry.name.length, 28)
    head.writeUInt32LE(entry.offset, 42)
    entry.name.copy(head, 46)
    chunks.push(head)
    centralSize += head.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054B50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  chunks.push(eocd)
  return Buffer.concat(chunks)
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const need = (offset: number, length: number, label: string) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
      throw new Error(`Office ZIP ${label}越界`)
    }
  }
  const out = new Map<string, Buffer>()
  let eocd = -1
  const start = Math.max(0, buffer.length - 65_557)
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054B50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Office 文件不是有效的 ZIP 容器')
  const count = buffer.readUInt16LE(eocd + 10)
  if (count > MAX_ZIP_ENTRIES) throw new Error(`Office ZIP 条目过多：${count}`)
  let at = buffer.readUInt32LE(eocd + 16)
  let totalUncompressed = 0
  for (let i = 0; i < count; i += 1) {
    need(at, 46, '中央目录')
    if (buffer.readUInt32LE(at) !== 0x02014B50) throw new Error('Office ZIP 中央目录损坏')
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const uncompressedSize = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    need(at + 46, nameLength + extraLength + commentLength, '中央目录条目')
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (!name.endsWith('/')) {
      if (flags & 0x1) throw new Error('Office ZIP 不支持加密条目')
      if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
        throw new Error(`Office ZIP 单条目解压后超过 ${Math.round(MAX_ZIP_ENTRY_BYTES / 1024 / 1024)}MB`)
      }
      if (totalUncompressed + uncompressedSize > MAX_ZIP_TOTAL_BYTES) {
        throw new Error(`Office ZIP 解压总量超过 ${Math.round(MAX_ZIP_TOTAL_BYTES / 1024 / 1024)}MB`)
      }
      need(localOffset, 30, '本地目录')
      if (buffer.readUInt32LE(localOffset) !== 0x04034B50) throw new Error('Office ZIP 本地目录损坏')
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataAt = localOffset + 30 + localNameLength + localExtraLength
      need(dataAt, compressedSize, '压缩数据')
      const compressed = buffer.subarray(dataAt, dataAt + compressedSize)
      let data: Buffer
      if (method === 0) {
        if (compressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error('Office ZIP 单条目超过读取上限')
        data = Buffer.from(compressed)
      } else if (method === 8) {
        const remaining = MAX_ZIP_TOTAL_BYTES - totalUncompressed
        const maxOutputLength = Math.min(MAX_ZIP_ENTRY_BYTES, remaining)
        data = zlib.inflateRawSync(compressed, { maxOutputLength })
      } else {
        throw new Error(`不支持的 ZIP 压缩方式：${method}`)
      }
      totalUncompressed += data.length
      if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) throw new Error('Office ZIP 解压总量超过读取上限')
      out.set(name, data)
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

function readDocx(buffer: Buffer): string {
  const files = unzip(buffer)
  const xml = files.get('word/document.xml')?.toString('utf8') || ''
  return xml.split(/<\/w:p>/i).map((paragraph) => {
    const withBreaks = paragraph
      .replace(/<w:tab\/>/gi, '\t')
      .replace(/<w:br\/>/gi, '\n')
    return textMatches(withBreaks, 'w:t').join('')
  }).filter(Boolean).join('\n')
}

function readPptx(buffer: Buffer): string {
  const files = unzip(buffer)
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0))
  return slides.map((name, index) => {
    const xml = files.get(name)?.toString('utf8') || ''
    const lines = xml.split(/<\/a:p>/i).map((paragraph) => textMatches(paragraph, 'a:t').join('')).filter(Boolean)
    return `## 幻灯片 ${index + 1}\n${lines.join('\n')}`
  }).join('\n\n')
}

function readXlsx(buffer: Buffer): { text: string; sheets: Array<{ name: string; rows: string[][] }> } {
  const files = unzip(buffer)
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || ''
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)].map((m) => textMatches(m[1], 't').join(''))
    : []
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') || ''
  const names = [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/gi)].map((m) => decodeXml(m[1]))
  const sheetNames = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] || 0) - Number(b.match(/sheet(\d+)/i)?.[1] || 0))
  const sheets = sheetNames.map((name, index) => {
    const xml = files.get(name)?.toString('utf8') || ''
    const rows: string[][] = []
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const row: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cellMatch[1]
        const type = /\bt="([^"]+)"/i.exec(attrs)?.[1] || ''
        const inner = cellMatch[2]
        const raw = textMatches(inner, 'v')[0] || textMatches(inner, 't').join('') || ''
        row.push(type === 's' ? (shared[Number(raw)] || '') : raw)
      }
      if (row.some((value) => value !== '')) rows.push(row)
    }
    return { name: names[index] || `Sheet${index + 1}`, rows }
  })
  const text = sheets.map((sheet) => `## ${sheet.name}\n${sheet.rows.map((row) => row.join('\t')).join('\n')}`).join('\n\n')
  return { text, sheets }
}

async function readPdf(buffer: Buffer, maxPages = 40): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const standardFontDataUrl = pathToFileURL(path.join(pdfRoot, 'standard_fonts') + path.sep).href
  const cMapUrl = pathToFileURL(path.join(pdfRoot, 'cmaps') + path.sep).href
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    useSystemFonts: true,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true
  })
  const doc = await task.promise
  const pages: string[] = []
  const count = Math.min(doc.numPages, Math.max(1, Number(maxPages) || 40))
  for (let i = 1; i <= count; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = (content.items || []).map((item) => String('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text) pages.push(`## 第 ${i} 页\n${text}`)
  }
  await (doc as unknown as { destroy?(): Promise<void> }).destroy?.()
  return pages.join('\n\n')
}

async function readOffice(filePath: string, buffer: Buffer, opts: { maxPages?: number } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.docx') return { format: 'docx', text: readDocx(buffer) }
  if (ext === '.xlsx') return { format: 'xlsx', ...readXlsx(buffer) }
  if (ext === '.pptx') return { format: 'pptx', text: readPptx(buffer) }
  if (ext === '.pdf') return { format: 'pdf', text: await readPdf(buffer, opts.maxPages) }
  throw new Error(`不支持的 Office 格式：${ext || '未知'}`)
}

function docxFromMarkdown(title: string, markdown: string): Buffer {
  const paragraphs: string[] = []
  const push = (value: string, opts: { bold?: boolean; size?: number; align?: string } = {}) => {
    const pPr = opts.align ? `<w:pPr><w:jc w:val="${opts.align}"/></w:pPr>` : ''
    const rPr = `${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : ''}`
    paragraphs.push(`<w:p>${pPr}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(value)}</w:t></w:r></w:p>`)
  }
  if (title) push(title, { bold: true, size: 36, align: 'center' })
  let inCode = false
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^```/.test(line.trim())) { inCode = !inCode; continue }
    if (!line.trim()) { push(''); continue }
    if (!inCode) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      if (heading) { push(heading[2], { bold: true, size: Math.max(22, 34 - heading[1].length * 3) }); continue }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
      if (bullet) { push(`• ${bullet[1]}`); continue }
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (ordered) { push(`• ${ordered[1]}`); continue }
    }
    push(line)
  }
  const documentXml = `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    },
    { name: 'word/document.xml', data: documentXml }
  ])
}

function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function sheetName(value: unknown, index: number): string {
  const clean = String(value || `Sheet${index + 1}`).replace(/[\\[\]*?:/]/g, '_').trim().slice(0, 31)
  return clean || `Sheet${index + 1}`
}

function xlsxCell(ref: string, value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`
}

function xlsxFromSheets(sheetsInput: OfficeSheet[]): Buffer {
  const sheets = (Array.isArray(sheetsInput) ? sheetsInput : []).slice(0, 20).map((sheet, index) => ({
    name: sheetName(sheet && sheet.name, index),
    rows: Array.isArray(sheet && sheet.rows) ? sheet.rows.slice(0, 5000) : []
  }))
  if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [] })
  const files: ZipEntry[] = []
  const overrides = sheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  files.push({
    name: '[Content_Types].xml',
    data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`
  })
  files.push({
    name: '_rels/.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  })
  const sheetTags = sheets.map((sheet, index) => `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
  const sheetRels = sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
  files.push({
    name: 'xl/workbook.xml',
    data: `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`
  })
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}</Relationships>`
  })
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, rowIndex) => {
      const values = Array.isArray(row) ? row.slice(0, 200) : []
      const cells = values.map((value, colIndex) => xlsxCell(`${columnName(colIndex)}${rowIndex + 1}`, value)).join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    }).join('')
    files.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
    })
  })
  return zipStore(files)
}

function pptTextShape(id: number, name: string, text: string, opts: { x: number; y: number; cx: number; cy: number; size: number; bold?: boolean; bullet?: boolean }) {
  const paragraph = String(text || '').split(/\r?\n/).map((line) => (
    `<a:p><a:r><a:rPr lang="zh-CN" sz="${opts.size}"${opts.bold ? ' b="1"' : ''}/><a:t>${xmlText(opts.bullet ? `• ${line}` : line)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>`
  )).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraph}</p:txBody></p:sp>`
}

function pptSlide(slide: OfficeSlide, index: number): string {
  const title = String(slide?.title || `第 ${index + 1} 页`)
  const bullets = Array.isArray(slide?.bullets) ? slide.bullets.map(String) : []
  return `${XML_DECL}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>${pptTextShape(2, 'Title', title, { x: 609600, y: 457200, cx: 10972800, cy: 1100000, size: 3200, bold: true })}${bullets.length ? pptTextShape(3, 'Content', bullets.join('\n'), { x: 914400, y: 1828800, cx: 10363200, cy: 4200000, size: 2000, bullet: true }) : ''}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

const PPT_THEME = `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
const PPT_MASTER = `${XML_DECL}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
const PPT_LAYOUT = `${XML_DECL}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

function pptxFromSlides(title: string, slidesInput: OfficeSlide[]): Buffer {
  const slides = (Array.isArray(slidesInput) ? slidesInput : []).slice(0, 100)
  if (!slides.length) slides.push({ title: title || '演示文稿', bullets: [] })
  const files: ZipEntry[] = []
  const overrides = slides.map((_slide, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  files.push({
    name: '[Content_Types].xml',
    data: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}</Types>`
  })
  files.push({
    name: '_rels/.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  })
  const slideIds = slides.map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`).join('')
  files.push({
    name: 'ppt/presentation.xml',
    data: `${XML_DECL}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  })
  const presRels = slides.map((_slide, index) => `<Relationship Id="rId${index + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${presRels}</Relationships>`
  })
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: PPT_MASTER })
  files.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
  })
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: PPT_LAYOUT })
  files.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
  })
  files.push({ name: 'ppt/theme/theme1.xml', data: PPT_THEME })
  slides.forEach((slide, index) => {
    files.push({ name: `ppt/slides/slide${index + 1}.xml`, data: pptSlide(slide, index) })
    files.push({
      name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      data: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
    })
  })
  return zipStore(files)
}

module.exports = {
  readOffice,
  docxFromMarkdown,
  xlsxFromSheets,
  pptxFromSlides,
  unzip,
  zipStore
}

import type { BrowserWindow as BrowserWindowType, FileFilter } from 'electron'
/**
 * 集锦「导出到文件」的**唯一落盘点**（主进程）。
 *
 * 为什么单独成文件：这条能力有两个入口 ——
 *   · 面板 ⋯ 菜单 → IPC `note:export-file`（ipc/notes.js）；
 *   · 快捷键 / 命令链 / 地址栏 `note:export`（main/note-actions.js）。
 * 两处若各写一份「保存框 + filters + 文件名清洗 + 写盘」，
 * 迟早出现"从面板导出是 .md、从快捷键导出却没扩展名"这类漂移。
 * 故对话框文案、filters、清洗规则、写盘全部收在这里，两边都只调 `saveNotesFile`。
 */

const fs = require('node:fs')
const { dialog, BrowserWindow } = require('electron')

/**
 * 内建三种格式在**原生保存框**上的呈现（标题 + 扩展名 filters）。
 * 中文标签只在这里出现一次；共享的只是"有哪三种格式"这个枚举。
 */
interface ExportSpec {
  label: string
  filters: FileFilter[]
}

interface NotesExportInput {
  format?: string
  filename?: string
  content?: string
  encoding?: 'utf8' | 'base64'
  win?: BrowserWindowType | null
}

type NotesExportResult = { ok: true; path: string } | { ok: false; canceled?: true; error?: string }

const EXPORT_SPECS: Readonly<Record<'md' | 'html' | 'json', ExportSpec>> = Object.freeze({
  md: { label: 'Markdown', filters: [{ name: 'Markdown', extensions: ['md'] }] },
  html: { label: 'HTML', filters: [{ name: 'HTML', extensions: ['html'] }] },
  json: { label: 'JSON', filters: [{ name: 'JSON', extensions: ['json'] }] }
})

/** 扩展名是**开放**的（插件可经 note.export-format 提供），只挡非法字符。 */
const EXTENSION_RE = /^[a-z0-9]{1,12}$/i

/**
 * 扩展名 → 保存框描述符。内建走 EXPORT_SPECS（有中文标签），
 * 未知扩展名现算一个（标签取大写扩展名）—— 这样插件格式不需要改这里一行。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function specFor(format: unknown): ExportSpec & { ext: string } {
  const ext = String(format || '').toLowerCase().replace(/^\./, '')
  const builtin = (EXPORT_SPECS as Readonly<Record<string, ExportSpec | undefined>>)[ext]
  if (builtin) return { ext, label: builtin.label, filters: builtin.filters }
  const label = ext ? ext.toUpperCase() : '文本'
  return { ext, label, filters: ext ? [{ name: label, extensions: [ext] }] : [] }
}

/** 默认文件名清洗：去掉 Windows 文件名非法字符（集锦名可能带 / : ? 等）。 */
function sanitizeFileName(name: unknown, fallback = '集锦.md'): string {
  const base = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ')
  return base || fallback
}

async function saveNotesFile({ format, filename, content, encoding, win }: NotesExportInput = {}): Promise<NotesExportResult> {
  const fmt = String(format || '').toLowerCase().replace(/^\./, '')
  if (!EXTENSION_RE.test(fmt)) return { ok: false, error: `不支持的导出格式：${fmt}` }
  const spec = specFor(fmt)
  try {
    const parent = win || BrowserWindow.getFocusedWindow() || undefined
    const options = {
      title: `导出集锦（${spec.label}）`,
      defaultPath: sanitizeFileName(filename || `集锦.${spec.ext}`, `集锦.${spec.ext}`),
      filters: spec.filters
    }
    const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    if (encoding === 'base64') fs.writeFileSync(res.filePath, Buffer.from(String(content || ''), 'base64'))
    else fs.writeFileSync(res.filePath, String(content || ''), 'utf8')
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: errorMessage(e) || '导出失败' }
  }
}

module.exports = { EXPORT_SPECS, sanitizeFileName, saveNotesFile }

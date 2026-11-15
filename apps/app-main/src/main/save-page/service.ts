/**
 * 保存网页服务（主进程）—— 「网页另存为…」的唯一落点。
 *
 * ── 为什么不放在动作表里 ──────────────────────────────────────────
 * 保存对话框、格式判定、失败兜底都是同一条流程；快捷键（Ctrl+S）、应用菜单、
 * PWA 应用窗菜单三个入口必须走**同一份**实现，否则三处的默认文件名 / 格式
 * 迟早不一致。这里把流程收成一个方法，入口只负责把「目标页面」交进来。
 *
 * ── 格式 ────────────────────────────────────────────────────────
 *   · 「网页，全部」→ `HTMLComplete`（HTML + 资源文件夹，与 Chrome 同款）
 *   · 「单个文件」  → `MHTML`（.mhtml，整页一个文件）
 * 选哪种由用户在保存对话框的扩展名决定，调用方不需要知道 SavePageType。
 */

const path = require('path')
const { dialog } = require('electron')
import type { BrowserWindow, WebContents } from 'electron'

type SaveKind = 'HTMLComplete' | 'MHTML'
interface SavePageTarget { webContents?: WebContents | null; title?: unknown; url?: unknown }
interface SavePageResult { ok: boolean; canceled?: boolean; filePath?: string; reason?: string }

/** 把标题/URL 变成一个人类可读的默认文件名（去掉各系统非法字符）。 */
function suggestedName(title?: string, url?: string): string {
  const raw = String(title || '').trim()
  if (raw) {
    const cleaned = raw.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned) return cleaned.slice(0, 120)
  }
  try {
    const u = new URL(String(url || ''))
    const host = u.hostname.replace(/^www\./, '')
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    return (last ? `${host} - ${last}` : host).slice(0, 120) || 'page'
  } catch (_) {
    return 'page'
  }
}

function createSavePageService() {
  /**
   * 打开保存对话框并保存。
   *
   * @param {SavePageTarget} target
   * @param {Electron.BrowserWindow|null} [ownerWindow] 对话框的父窗口（缺省挂到目标页所在窗口）
   * @returns {Promise<{ok:boolean, canceled?:boolean, filePath?:string, reason?:string}>}
   */
  async function save(target: SavePageTarget, ownerWindow?: BrowserWindow | null): Promise<SavePageResult> {
    const wc = target && target.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ok: false, reason: 'SAVE_TARGET_GONE' }
    }
    let parent: BrowserWindow | null = ownerWindow || null
    if (!parent || (typeof parent.isDestroyed === 'function' && parent.isDestroyed())) {
      try {
        const { BrowserWindow } = require('electron')
        parent = BrowserWindow.fromWebContents(wc) || null
      } catch (_) {
        parent = null
      }
    }
    const res = await dialog.showSaveDialog(parent, {
      title: '保存网页',
      defaultPath: `${suggestedName(
        typeof target.title === 'string' ? target.title : undefined,
        typeof target.url === 'string' ? target.url : undefined
      )}.html`,
      filters: [
        { name: '网页，全部', extensions: ['html', 'htm'] },
        { name: '单个文件（MHTML）', extensions: ['mhtml'] }
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }

    const ext = path.extname(res.filePath).toLowerCase()
    const kind: SaveKind = ext === '.mhtml' ? 'MHTML' : 'HTMLComplete'
    try {
      await wc.savePage(res.filePath, kind)
      return { ok: true, filePath: res.filePath }
    } catch (error) {
      // MHTML 在部分平台 / 页面类型上可能失败 —— 退一次「全部」，不让用户空手而归。
      if (kind === 'MHTML') {
        try {
          const fallback = res.filePath.replace(/\.mhtml$/i, '.html')
          await wc.savePage(fallback, 'HTMLComplete')
          return { ok: true, filePath: fallback }
        } catch (_) {}
      }
      return { ok: false, reason: error instanceof Error ? error.message : 'SAVE_FAILED' }
    }
  }

  return { save, suggestedName }
}

module.exports = { createSavePageService }

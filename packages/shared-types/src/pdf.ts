/**
 * pdf.mjs —— 内置 PDF 阅读器设置的**唯一真源**
 *
 * 键名被三层共用：域层缺省值、设置页、主进程（`pdfViewerEnabledPort`），
 * 缩放缺省值还被内置查看器页面（`pages/pdf`）读取 —— 抄错一处就是
 * "设置里选了 150%，打开还是 120%"。
 *
 * 取值集合（缩放档位）只在这里声明一次；设置页与查看器都从这份派生。
 */

/** 设置键名。 */
const PDF_SETTING_KEYS = Object.freeze({
  /** 是否用内置查看器接管 .pdf（关闭则走 Chromium 下载链路）。 */
  viewerEnabled: 'pdf.viewer_enabled',
  /** 打开 PDF 时的初始缩放（字符串，pdfjs 的 viewport scale）。 */
  defaultZoom: 'pdf.default_zoom'
})

/** 初始缩放下拉的 [值, 显示名]；顺序即设置页顺序。 */
const PDF_ZOOM_OPTIONS = Object.freeze([
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.2', '120%'],
  ['1.5', '150%'],
  ['2', '200%']
])

/** 缺省缩放（= 120%）。 */
const DEFAULT_PDF_ZOOM = '1.2'

export { PDF_SETTING_KEYS, PDF_ZOOM_OPTIONS, DEFAULT_PDF_ZOOM }

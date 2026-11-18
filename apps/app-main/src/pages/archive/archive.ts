import {
  IPC_ROUTES,
  rpc,
  el,
  initTheme,
  openLink
} from 'hira://shared/runtime.js'
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import type { PageRpcRecord } from 'hira://shared/runtime.js'

interface ArchivedPage extends PageRpcRecord {
  id: string
  title?: string
  url?: string
  content?: string
  sourceTitle?: string
  archiveUrl?: string
}

function requiredElement<T>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Archive page element #${id} is unavailable`)
  return node as T
}

const titleNode = requiredElement<HTMLElement>('archive-title')
const originNode = requiredElement<HTMLAnchorElement>('archive-origin')
const backButton = requiredElement<HTMLButtonElement>('archive-back')
const reader = requiredElement<HTMLElement>('archive-reader')
const loading = requiredElement<HTMLElement>('archive-loading')

initTheme()

function goBack(): void {
  if (history.length > 1) history.back()
  else location.href = pageUrl('newtab')
}

backButton.addEventListener('click', goBack)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') goBack()
})

async function load(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id') || ''
  if (!id) {
    loading.className = 'archive-error'
    loading.textContent = '缺少归档记录编号。'
    return
  }

  let note: ArchivedPage | null = null
  try {
    note = await rpc<ArchivedPage | null>(IPC_ROUTES.pageArchiveGet, { id })
  } catch (error) {
    loading.className = 'archive-error'
    loading.textContent = error instanceof Error ? error.message : '离线归档读取失败'
    return
  }

  if (!note) {
    loading.className = 'archive-error'
    loading.textContent = '离线归档不存在或已被删除。'
    return
  }

  const pageTitle = note.sourceTitle || note.title || '离线归档'
  titleNode.textContent = pageTitle
  document.title = `${pageTitle} · 离线归档`
  if (note.url) {
    originNode.textContent = note.url
    originNode.title = note.url
    originNode.hidden = false
    originNode.addEventListener('click', (event) => openLink(note?.url || '', event))
  }

  reader.replaceChildren()
  if (note.archiveUrl) {
    const frame = document.createElement('iframe')
    frame.className = 'archive-frame'
    frame.title = pageTitle
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.src = note.archiveUrl
    frame.addEventListener('load', () => { loading.hidden = true })
    reader.appendChild(frame)
  }

  if (note.content) {
    const fallback = el('details', 'archive-fallback') as HTMLDetailsElement
    if (!note.archiveUrl) fallback.open = true
    fallback.appendChild(el('summary', '', '文本备份'))
    fallback.appendChild(el('pre', '', note.content))
    reader.appendChild(fallback)
  }

  if (!note.archiveUrl && !note.content) {
    const empty = el('div', 'archive-error', '该归档没有可显示的页面内容。')
    reader.appendChild(empty)
    loading.hidden = true
  }
}

void load()

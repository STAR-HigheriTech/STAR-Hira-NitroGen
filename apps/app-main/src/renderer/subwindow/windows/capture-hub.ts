import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { CAPTURE_HUB_TARGETS, type CaptureHubPayload, type CaptureHubTarget } from '@hira-ng/shared-types/src/capture-hub.mjs'
import type { SubwindowMountContext } from './contract.js'

const CSS = `
  .capture-hub { display:flex; flex-direction:column; gap:12px; height:100%; }
  .capture-hub__source { min-width:0; padding:9px 11px; border-radius:var(--hira-radius-sm,8px); background:var(--hira-surface-soft,rgba(0,0,0,.04)); }
  .capture-hub__title { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .capture-hub__url { margin-top:3px; font-size:11.5px; opacity:.55; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .capture-hub__targets { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
  .capture-hub__target { height:34px; border:1px solid var(--hira-border-subtle,rgba(0,0,0,.12)); border-radius:var(--hira-radius-sm,8px); background:transparent; color:inherit; font:inherit; font-size:12.5px; cursor:pointer; transition:background 120ms ease,border-color 120ms ease,color 120ms ease; }
  .capture-hub__target:hover { background:var(--hira-surface-soft,rgba(0,0,0,.045)); border-color:var(--hira-border-strong,rgba(0,0,0,.2)); }
  .capture-hub__target:focus-visible,.capture-hub__btn:focus-visible { outline:none; box-shadow:var(--hira-focus-ring,0 0 0 2px rgba(59,130,246,.35)); }
  .capture-hub__target[aria-pressed="true"] { background:var(--hira-accent-soft,rgba(0,120,212,.12)); border-color:transparent; color:var(--hira-accent,#0b6bbd); font-weight:600; }
  .capture-hub__field { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--hira-text-secondary,#666); }
  .capture-hub__field input,.capture-hub__field textarea { box-sizing:border-box; width:100%; border:1px solid var(--hira-border-subtle,rgba(0,0,0,.12)); border-radius:var(--hira-radius-sm,8px); background:var(--hira-field-bg,rgba(0,0,0,.025)); color:inherit; font:inherit; padding:8px 10px; }
  .capture-hub__field textarea { min-height:112px; resize:vertical; line-height:1.55; }
  .capture-hub__footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
  .capture-hub__status { flex:1; min-width:0; font-size:12px; color:var(--hira-text-secondary,#666); }
  .capture-hub__status[data-error="true"] { color:var(--hira-danger,#c62828); }
  .capture-hub__btn { min-width:82px; height:30px; border-radius:var(--hira-radius-sm,8px); border:1px solid var(--hira-border-subtle,rgba(0,0,0,.16)); background:transparent; color:inherit; font:inherit; font-size:13px; cursor:pointer; transition:background 120ms ease,border-color 120ms ease; }
  .capture-hub__btn:hover:not(:disabled) { background:var(--hira-surface-soft,rgba(0,0,0,.045)); border-color:var(--hira-border-strong,rgba(0,0,0,.2)); }
  .capture-hub__btn:disabled { opacity:.5; cursor:default; }
  .capture-hub__btn[data-primary="true"] { border-color:transparent; background:var(--hira-accent,#3b82f6); color:var(--hira-on-accent,#fff); }
  @media (max-width:460px){ .capture-hub__targets{grid-template-columns:repeat(2,1fr)} }
`

function parsePayload(params: URLSearchParams): CaptureHubPayload | null {
  try {
    const value = JSON.parse(params.get('payload') || '{}')
    return value && typeof value.url === 'string' ? value as CaptureHubPayload : null
  } catch {
    return null
  }
}

function invoke(route: string, payload: unknown): Promise<unknown> {
  const api = globalThis.window?.hira
  if (!api?.provider || typeof api.provider.invoke !== 'function') return Promise.reject(new Error('window.hira.provider unavailable'))
  return api.provider.invoke(route, payload)
}

export function mountCaptureHub({ params, content }: SubwindowMountContext): void {
  if (!document.getElementById('capture-hub-css')) {
    const style = document.createElement('style')
    style.id = 'capture-hub-css'
    style.textContent = CSS
    document.head.appendChild(style)
  }
  content.textContent = ''
  const source = parsePayload(params)
  if (!source) {
    content.textContent = '来源页面已失效，请回到网页重新收集。'
    return
  }

  const root = document.createElement('div')
  root.className = 'capture-hub'
  const sourceCard = document.createElement('div')
  sourceCard.className = 'capture-hub__source'
  const sourceTitle = document.createElement('div')
  sourceTitle.className = 'capture-hub__title'
  sourceTitle.textContent = source.title || source.url
  const sourceUrl = document.createElement('div')
  sourceUrl.className = 'capture-hub__url'
  sourceUrl.textContent = source.url
  sourceCard.append(sourceTitle, sourceUrl)

  const targets = document.createElement('div')
  targets.className = 'capture-hub__targets'
  let target: CaptureHubTarget = source.kind === 'image' ? 'notes' : 'reading'
  const targetButtons: HTMLButtonElement[] = []
  for (const [id, label] of CAPTURE_HUB_TARGETS) {
    if (source.kind === 'image' && id === 'reading') continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'capture-hub__target'
    button.textContent = label
    button.dataset.target = id
    button.setAttribute('aria-pressed', String(id === target))
    button.addEventListener('click', () => {
      target = id as CaptureHubTarget
      for (const item of targetButtons) item.setAttribute('aria-pressed', String(item.dataset.target === target))
      syncTargetUi()
    })
    targetButtons.push(button)
    targets.appendChild(button)
  }

  const titleField = document.createElement('label')
  titleField.className = 'capture-hub__field'
  titleField.append('标题')
  const titleInput = document.createElement('input')
  titleInput.value = source.suggestedTitle || source.title || source.url
  titleInput.maxLength = 200
  titleField.appendChild(titleInput)

  const textField = document.createElement('label')
  textField.className = 'capture-hub__field'
  const textLabel = document.createElement('span')
  textLabel.textContent = '摘录 / 备注'
  textField.append(textLabel)
  const textArea = document.createElement('textarea')
  textArea.value = source.selection || ''
  textArea.placeholder = '留空时收集整个页面；有文字时保存为摘录卡片。'
  textArea.maxLength = 20000
  textField.appendChild(textArea)

  const tagsField = document.createElement('label')
  tagsField.className = 'capture-hub__field'
  tagsField.append('标签（逗号分隔）')
  const tagsInput = document.createElement('input')
  tagsInput.placeholder = '工作, 待读'
  tagsInput.maxLength = 300
  tagsField.appendChild(tagsInput)
  const syncTargetUi = () => {
    tagsField.hidden = target !== 'bookmark'
    textLabel.textContent = target === 'bookmark' ? '备注' : target === 'easel' ? '卡片说明' : '摘录 / 备注'
    if (source.kind === 'image') {
      textArea.placeholder = '可选：为这张图片补充说明。'
    } else if (source.kind === 'link') {
      textArea.placeholder = '可选：记录为什么保存这个链接。'
    } else if (source.kind === 'selection') {
      textArea.placeholder = '已带入所选内容，可继续编辑。'
    } else {
      textArea.placeholder = '留空时收集整个页面；有文字时保存为摘录卡片。'
    }
  }

  const footer = document.createElement('div')
  footer.className = 'capture-hub__footer'
  const status = document.createElement('div')
  status.className = 'capture-hub__status'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'capture-hub__btn'
  cancel.textContent = '取消'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'capture-hub__btn'
  save.dataset.primary = 'true'
  save.textContent = '收集'
  footer.append(status, cancel, save)

  const close = () => { try { window.close() } catch {} }
  let busy = false
  cancel.addEventListener('click', close)
  save.addEventListener('click', async () => {
    if (busy) return
    busy = true
    save.disabled = true
    status.dataset.error = 'false'
    status.textContent = '正在收集…'
    try {
      const result = await invoke(IPC_ROUTES.captureHubCommit, {
        target,
        title: titleInput.value,
        text: textArea.value,
        tags: tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        source: {
          tabId: source.tabId,
          url: source.url,
          title: source.title,
          selection: source.selection,
          kind: source.kind,
          ...(source.referer ? { referer: source.referer } : {})
        }
      }) as { ok?: boolean; reason?: string }
      if (result?.ok === false) throw new Error(result.reason || '收集失败')
      const label = CAPTURE_HUB_TARGETS.find(([id]) => id === target)?.[1] || '目标面板'
      status.textContent = `已收集到${label}，正在打开对应面板…`
      window.setTimeout(close, 620)
    } catch (error) {
      status.dataset.error = 'true'
      status.textContent = error instanceof Error ? error.message : String(error)
      save.disabled = false
      busy = false
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      save.click()
    }
  })
  root.append(sourceCard, targets, titleField, textField, tagsField, footer)
  content.appendChild(root)
  syncTargetUi()
  titleInput.focus()
  titleInput.select()
}

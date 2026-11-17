/**
 * Section：证书与连接安全性。
 *
 * 数据来自 `security:site`（主进程 CDP + X509 解析）。本 section **只负责展示**，
 * 查询失败时给出人话原因 —— 证书永远不能让整个浮层不可用。
 */

import { createSection, el, formatDate, certificateErrorText } from './shared.js'

/** @param {Document} doc @param {string} label */
function kvRow(doc: Document, label: string) {
  const row = el(doc, 'div', 'hira-overlay-row si-kv')
  const key = el(doc, 'span', 'si-kv-key', label)
  const value = el(doc, 'span', 'hira-overlay-label si-kv-value')
  row.appendChild(key)
  row.appendChild(value)
  return { row, value }
}

/** @type {import('./registry.js').SiteInfoSection} */
export const certificateSection: import('./registry.js').SiteInfoSection = {
  id: 'certificate',
  order: 20,
  create(ctx) {
    const { doc, emit } = ctx

    const shell = createSection(doc, {
      id: 'certificate',
      title: '证书',
      action: { label: '查看详情', onActivate: () => emit('open-certificates') }
    })

    const subject = kvRow(doc, '颁发给')
    const issuer = kvRow(doc, '颁发者')
    const validity = kvRow(doc, '有效期')
    const serial = kvRow(doc, '序列号')
    const fingerprint = kvRow(doc, '指纹')
    const san = kvRow(doc, '覆盖域名')
    const chain = kvRow(doc, '证书链')
    const note = el(doc, 'div', 'si-note')

    shell.body.appendChild(subject.row)
    shell.body.appendChild(issuer.row)
    shell.body.appendChild(validity.row)
    shell.body.appendChild(serial.row)
    shell.body.appendChild(fingerprint.row)
    shell.body.appendChild(san.row)
    shell.body.appendChild(chain.row)
    shell.body.appendChild(note)

    const allRows = [subject, issuer, validity, serial, fingerprint, san, chain]

    function showRows(visible: boolean) {
      for (const item of allRows) item.row.hidden = !visible
    }

    return {
      element: shell.root,
      update(state) {
        const site = (state && state.context && state.context.site) || null
        const cert = state.certificate
        const loading = !!cert.loading
        const secure = !!(site && site.secure)

        note.classList.remove('is-warning')
        note.title = ''

        if (!site || !site.url) {
          showRows(false)
          note.hidden = false
          note.textContent = '没有活动页面。'
          shell.setActionVisible(false)
          return
        }

        if (!secure) {
          showRows(false)
          note.hidden = false
          note.classList.add('is-warning')
          note.textContent = '此站点未使用 HTTPS，连接未加密。'
          shell.setActionVisible(false)
          return
        }

        if (loading && !cert.certificate) {
          showRows(false)
          note.hidden = false
          note.textContent = '正在读取证书…'
          shell.setActionVisible(false)
          return
        }

        const certificate = cert.certificate
        if (!certificate) {
          showRows(false)
          note.hidden = false
          const reason = certificateErrorText(cert.error)
          if (reason) {
            note.classList.add('is-warning')
            note.textContent = `暂时无法读取证书：${reason}`
            note.title = String(cert.error || '')
          } else {
            note.textContent = '此页面没有可展示的证书。'
          }
          // HTTPS 读取失败时仍允许进入证书页：那里能看到会话快照与失败记录。
          shell.setActionVisible(true)
          return
        }

        note.hidden = true
        showRows(true)
        shell.setActionVisible(true)

        subject.value.textContent = certificate.subjectName || '—'
        issuer.value.textContent = certificate.issuerName || '—'

        const start = formatDate(certificate.validStart)
        const end = formatDate(certificate.validExpiry)
        validity.value.textContent = start && end ? `${start} → ${end}` : (end || start || '—')
        validity.value.classList.remove('is-warning')
        if (certificate.validExpiry && Number(certificate.validExpiry) < Date.now()) {
          validity.value.classList.add('is-warning')
        }

        const serialNumber = certificate.serialNumber || ''
        if (serialNumber) {
          serial.row.hidden = false
          serial.value.textContent = serialNumber.length > 29 ? `${serialNumber.slice(0, 29)}…` : serialNumber
          serial.value.title = serialNumber
        } else {
          serial.row.hidden = true
        }

        const print = certificate.fingerprint || ''
        if (print) {
          fingerprint.row.hidden = false
          fingerprint.value.textContent = print.length > 29 ? `${print.slice(0, 29)}…` : print
          fingerprint.value.title = print
        } else {
          fingerprint.row.hidden = true
        }

        const names = Array.isArray(certificate.san) ? certificate.san.filter(Boolean) : []
        if (names.length) {
          san.row.hidden = false
          const shown = names.slice(0, 3).join(', ')
          san.value.textContent = names.length > 3 ? `${shown} 等 ${names.length} 个` : shown
          san.value.title = names.join('\n')
        } else {
          san.row.hidden = true
        }

        const certificateChain = Array.isArray(cert.certificateChain) ? cert.certificateChain : []
        if (certificateChain.length > 1) {
          chain.row.hidden = false
          chain.value.textContent = `${certificateChain.length} 张`
          chain.value.title = certificateChain
            .map((item, index) => `${index === 0 ? '叶证书' : `证书 ${index + 1}`}：${item.subjectName || '—'}`)
            .join('\n')
        } else {
          chain.row.hidden = true
        }
      }
    }
  }
}


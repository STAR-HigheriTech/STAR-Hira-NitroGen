/*
 * 分享页渲染逻辑（N15）—— `hira://share?url=<encoded>`
 *
 * 与 settings / history 等内部页同构：静态 HTML + 一个 ES Module，**没有打包器**，
 * 只认两样东西：标准 preload 桥（`window.hira`）与 `share:qr` 这一条 IPC。
 *
 * 分工：**生成二维码在主进程**（`qr` 是 Node 侧依赖，本页 import 不到），
 * 本页只把返回的 SVG 内联进 DOM —— 于是"怎么编码"只有一处实现。
 *
 * 取 URL / 拼分享链接的唯一实现在 shared-types#share.mjs（本页经
 * `hira://shared/share.mjs` 读到同一份），不在这里再抄一遍 URLSearchParams 解析。
 */
import { pageUrlFromShareQuery } from 'hira://shared/share.mjs'
import type { PageRpcRecord } from 'hira://shared/runtime.js'
import { errorMessage } from 'hira://shared/page-kit.js'

;(function () {
  'use strict'

  const bridge = window.hira
  function requiredElement<T>(id: string): T {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Share page element #${id} is unavailable`)
    return element as unknown as T
  }
  const qrEl = requiredElement<HTMLElement>('qr')
  const urlEl = requiredElement<HTMLElement>('url')
  const copyBtn = requiredElement<HTMLButtonElement>('copy')
  const openBtn = requiredElement<HTMLButtonElement>('open')

  function invoke<T = PageRpcRecord>(route: string, payload?: unknown): Promise<T> {
    if (bridge && bridge.provider && typeof bridge.provider.invoke === 'function') {
      return bridge.provider.invoke<T>(route, payload || {})
    }
    return Promise.reject(new Error('window.hira.provider unavailable'))
  }

  const url = pageUrlFromShareQuery(location.search) || ''
  if (!url) {
    qrEl.innerHTML = ''
    urlEl.className = 'empty'
    urlEl.textContent = '没有可分享的地址。'
    copyBtn.disabled = true
    openBtn.disabled = true
    return
  }

  urlEl.textContent = url
  urlEl.title = url

  // 生成二维码（主进程）：失败时不摆一个空白方块，而是如实说明。
  invoke('share:qr', { text: url })
    .then(function (res: Record<string, unknown>) {
      const svg = res && typeof res.svg === 'string' ? res.svg : ''
      if (!svg) {
        urlEl.textContent = url + '\n（这条地址太长，无法生成二维码）'
        return
      }
      // SVG 由主进程用 `qr` 生成，内容是我们自己的 URL 经编码器产出的 markup；
      // 这里用 innerHTML 内联（与设置页渲染信任内容的做法一致）。
      qrEl.innerHTML = svg
    })
    .catch(function () {
      urlEl.textContent = url + '\n（二维码生成失败）'
    })

  copyBtn.addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(url)
      copyBtn.textContent = '已复制'
      window.setTimeout(function () { copyBtn.textContent = '复制链接' }, 1200)
    } catch (error) {
      urlEl.textContent = url + '\n（复制失败：' + errorMessage(error) + '）'
    }
  })

  openBtn.addEventListener('click', async function () {
    // 在本窗口新开一个标签打开目标地址（不是导航本页 —— 那会把分享页顶掉）。
    try { await invoke('tab:new', { url: url }) } catch (error) {
      urlEl.textContent = url + '\n（打开失败：' + errorMessage(error) + '）'
    }
  })
})()

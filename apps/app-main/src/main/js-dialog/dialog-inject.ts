import type { WebContents } from 'electron'
import { errorMessage } from '../ipc/types'

export type JsDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

const injected = new WeakSet<WebContents>()

/**
 * JS Dialog main world 注入脚本
 *
 * 完全复刻 Hira main/ipc/jsDialog.js 的 global.injectJsDialogOverride 实现：
 *   - 通过 webContents.executeJavaScript 注入到 main world
 *   - 重写 window.alert / window.confirm / window.prompt / window.onbeforeunload
 *   - 调用 __jsDialogBridge（由 preload contextBridge 暴露）与主进程通信
 *
 * 注入时机：每次 dom-ready（覆盖初次加载和后续导航）
 * 必须用 webContents.executeJavaScript（不是 preload 中的 webFrame.executeJavaScript）
 * 因为后者在 isolated world 执行，不会影响 main world 的 window 对象
 */

/**
 * 生成 main world 注入脚本
 * @param {string[]} types - 要重写的类型数组 ['alert','confirm','prompt','beforeunload']
 * @returns {string} 注入脚本代码
 */
export function buildInjectScript (types: readonly JsDialogType[] | null | undefined): string {
  if (!types || !types.length) return ''

  const T_ALERT = types.indexOf('alert') !== -1
  const T_CONFIRM = types.indexOf('confirm') !== -1
  const T_PROMPT = types.indexOf('prompt') !== -1
  const T_BEFOREUNLOAD = types.indexOf('beforeunload') !== -1

  const script = [
    '(function(){',
    '  if (window.__jsDialogOverridden) { return; }',
    '  var bridge = window.__jsDialogBridge;',
    '  if (!bridge || typeof bridge.show !== "function") { return; }',
    '  window.__jsDialogOverridden = true;',
    '  function _jds(v){try{return String(v==null?"":v)}catch(_){return""}}'
  ]

  if (T_ALERT) {
    script.push('  window.alert = function (m){try{bridge.show({type:"alert",message:_jds(m),url:location.href})}catch(_){}return void 0};')
  }
  if (T_CONFIRM) {
    script.push('  window.confirm = function (m){try{if(typeof bridge.confirmSync==="function"){return bridge.confirmSync({type:"confirm",message:_jds(m),url:location.href})}else{bridge.show({type:"confirm",message:_jds(m),url:location.href})}}catch(_){}return false};')
  }
  if (T_PROMPT) {
    script.push('  window.prompt = function (m,d){try{if(typeof bridge.promptSync==="function"){return bridge.promptSync({type:"prompt",message:_jds(m),defaultValue:arguments.length<2?"":_jds(d),url:location.href})}else{bridge.show({type:"prompt",message:_jds(m),defaultValue:arguments.length<2?"":_jds(d),url:location.href})}}catch(_){}return null};')
  }
  if (T_BEFOREUNLOAD) {
    script.push('  try{(function(){')
    script.push('    var _ob=null;')
    script.push('    Object.defineProperty(window,"onbeforeunload",{configurable:true,enumerable:true,')
    script.push('      get:function(){return _ob},')
    script.push('      set:function(fn){')
    script.push('        _ob=(typeof fn==="function")?fn:null;')
    script.push('        if(_ob){window.addEventListener("beforeunload",function(e){')
    script.push('          try{var r=_ob.call(window,e);if(typeof r==="string"&&r.length>0){bridge.show({type:"beforeunload",message:r,url:location.href})}}catch(_){}')
    script.push('        },{capture:true,once:false})}}});')
    script.push('  })()}catch(_){}')
  }

  script.push('})();')

  return script.join('\n')
}

/**
 * 注入 main world 重写脚本到 webContents
 * @param {import('electron').WebContents} webContents
 * @param {string[]} types - 要重写的类型
 */
export function injectNow (webContents: WebContents | null | undefined, types: readonly JsDialogType[]): void {
  if (!webContents || webContents.isDestroyed()) return

  const code = buildInjectScript(types)
  if (!code) return

  try {
    // true = userGesture，确保某些场景下能正确执行
    webContents.executeJavaScript(code, true).catch(function (error: unknown) {
      console.error('[jsDialog] executeJavaScript FAILED:', errorMessage(error))
    })
  } catch (e) {
    console.error('[jsDialog] executeJavaScript threw:', errorMessage(e))
  }
}

/**
 * 注册 webContents 的 dom-ready 监听，每次 dom-ready 注入重写脚本
 * 用 listener wrapping 防止重复监听
 * @param {import('electron').WebContents} webContents
 * @param {() => string[]} getTypes - 获取要重写的类型
 */
export function registerInjection (webContents: WebContents | null | undefined, getTypes: () => JsDialogType[]): void {
  if (!webContents || typeof webContents.on !== 'function') return
  if (injected.has(webContents)) return
  injected.add(webContents)

  // 每次 dom-ready 注入一次（覆盖导航后 main world 重置的情况）。
  // **只挂这一个**：dom-ready 早于 did-finish-load 且同一文档必达，再挂 did-finish-load
  // 只会对**同一文档**重复 executeJavaScript（脚本里虽有 `__jsDialogOverridden` 早退，
  // 但那次跨进程往返 + 脚本解析仍是纯浪费）。导航后的新文档由新的 dom-ready 覆盖。
  webContents.on('dom-ready', function () {
    injectNow(webContents, getTypes())
  })
}


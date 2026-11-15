/**
 * fingerprint.mjs —— 浏览器指纹伪装的**唯一真源**（数据模型 + 随机生成 + 注入脚本）
 *
 * ── 分层约定 ──────────────────────────────────────────────────────
 * · **模型与生成**在本文件：主进程（随机生成 IPC / 注入 applier）与设置页
 *   （schema 驱动的通用 record 渲染）读的是同一份归一化规则。
 * · **注入**只在主进程发生：`buildFingerprintScript()` 产出主世界脚本，
 *   applier 用 `webContents.executeJavaScript(code, true)` 下发。
 * · 页面侧不认识"指纹"这件事：它只按 settings schema 的 `type:'record'`
 *   画出一组子字段，随机生成走通用路由 `settings:record-generate`。
 *
 * ── 为什么值与"开关"是同一份数据 ──────────────────────────────────
 * 关闭 = 值是 `null`（没有半开状态）；开启 = 一个完整对象。
 * 归一化把任何残缺/手改/旧版本对象收敛成**可直接注入**的形态，
 * 因此主进程与页面都不需要再做第二遍校验。
 *
 * 纯模块：零依赖、零 IO、不 require electron。
 */

/** 设置键名（设置页 schema 与 applier 共用）。 */
const FINGERPRINT_SETTING_KEY = 'privacy.fingerprint'

/** 平台可选值（与 Chromium `navigator.platform` 的常见取值一致）。 */
const FINGERPRINT_PLATFORM_OPTIONS = Object.freeze([
  ['Win32', 'Windows'],
  ['MacIntel', 'macOS'],
  ['Linux x86_64', 'Linux']
])

/** 随机生成用的 WebGL 组合池（厂商, 渲染器）——取真实常见值，避免一眼假。 */
const WEBGL_POOL = Object.freeze([
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['NVIDIA Corporation', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['NVIDIA Corporation', 'ANGLE (NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Advanced Micro Devices, Inc.', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (ATI Technologies Inc.)', 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)']
])

const CORES_POOL = Object.freeze([4, 6, 8, 8, 12, 16])
const MEMORY_POOL = Object.freeze([4, 8, 16, 16, 32])

export interface FingerprintData {
  enabled: true
  platform: string
  hardwareConcurrency: number
  deviceMemory: number
  languages: string[]
  canvasSeed: number
  audioSeed: number
  webglVendor: string
  webglRenderer: string
}

/** 归一化数值：非有限数 → 默认；越界 → 夹取。 */
function pickInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 归一化语言列表：接受数组或逗号串，去空去重；空 → 默认中文。 */
function normalizeLanguages(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(',')
  const out: string[] = []
  for (const item of raw) {
    const lang = String(item == null ? '' : item).trim()
    if (!lang || out.includes(lang)) continue
    out.push(lang)
    if (out.length >= 8) break
  }
  return out.length ? out : ['zh-CN', 'zh']
}

/**
 * 把任意存值收敛成可注入的指纹对象。
 * `null` / `undefined` / `false` / 非对象 → **null**（= 关闭）。
 *
 * @param {any} raw
 * @returns {null | { enabled:true, platform:string, hardwareConcurrency:number,
 *   deviceMemory:number, languages:string[], canvasSeed:number, audioSeed:number,
 *   webglVendor:string, webglRenderer:string }}
 */
function normalizeFingerprint(raw: unknown): FingerprintData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  // 兼容旧模型里显式的 `enabled:false`
  if (source.enabled === false) return null

  const platform = FINGERPRINT_PLATFORM_OPTIONS.some((o) => o[0] === source.platform)
    ? String(source.platform)
    : 'Win32'

  return {
    enabled: true,
    platform,
    hardwareConcurrency: pickInt(source.hardwareConcurrency, 8, 1, 128),
    deviceMemory: pickInt(source.deviceMemory, 8, 1, 128),
    languages: normalizeLanguages(source.languages),
    canvasSeed: pickInt(source.canvasSeed, 0, 0, 999999),
    audioSeed: pickInt(source.audioSeed, 0, 0, 999999),
    webglVendor: typeof source.webglVendor === 'string' ? source.webglVendor.trim().slice(0, 256) : '',
    webglRenderer: typeof source.webglRenderer === 'string' ? source.webglRenderer.trim().slice(0, 512) : ''
  }
}

/** [min, max) 随机整数。 */
function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * Math.max(1, max - min))
}

/** 从数组里随机取一项。 */
function randomPick<T>(list: readonly T[]): T {
  return list[randomInt(0, list.length)]
}

/**
 * 生成一份全新的随机指纹（每次调用都不同；种子也重新掷）。
 * @returns {NonNullable<ReturnType<typeof normalizeFingerprint>>}
 */
function generateFingerprint() : NonNullable<ReturnType<typeof normalizeFingerprint>> {
  const pair = randomPick(WEBGL_POOL)
  return {
    enabled: true,
    platform: randomPick(FINGERPRINT_PLATFORM_OPTIONS)[0],
    hardwareConcurrency: randomPick(CORES_POOL),
    deviceMemory: randomPick(MEMORY_POOL),
    languages: ['zh-CN', 'zh'],
    canvasSeed: randomInt(100000, 999999),
    audioSeed: randomInt(100000, 999999),
    webglVendor: pair[0],
    webglRenderer: pair[1]
  }
}

/**
 * 构造主世界注入脚本。
 *
 * 设计要点：
 * 1. **幂等**：同一个 document 只会装一次"钩子"；再次注入只更新
 *    `window.__hiraFp`。于是"页面开着时改设置"无需重装原型链，
 *    且关闭（fp = null）时所有钩子自动回落原生行为。
 * 2. **钩子读活配置**：所有 getter / 包装函数每次调用都读 `window.__hiraFp`，
 *    不再把值烤进闭包 —— 这是"改完立即对新读取生效"的前提。
 * 3. 任何一步失败都吞掉：指纹是增强能力，绝不能把页面脚本搞崩。
 *
 * @param {any} raw 设置值（`null` = 关闭；仍会下发一个"清空配置"的脚本）
 * @returns {string} 可交给 `webContents.executeJavaScript(code, true)` 的脚本
 */
function buildFingerprintScript(raw: unknown) : string {
  const fp = normalizeFingerprint(raw)
  const config = fp ? JSON.stringify(fp) : 'null'

  return `(function(){
  var cfg = ${config};
  try { window.__hiraFp = cfg; } catch (e) { return; }
  if (!cfg) return;
  if (window.__hiraFpHooks) return;
  try { window.__hiraFpHooks = true; } catch (e) { return; }

  function current() {
    var c = window.__hiraFp;
    return c && c.enabled ? c : null;
  }

  function override(prop, getValue) {
    try {
      var original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), prop)
      var fallback = original && original.get ? original.get : function () { return undefined; }
      Object.defineProperty(navigator, prop, {
        configurable: true,
        enumerable: true,
        get: function () {
          var c = current();
          return c ? getValue(c) : fallback.call(navigator);
        }
      });
    } catch (e) {}
  }

  override('platform', function (c) { return c.platform; });
  override('hardwareConcurrency', function (c) { return c.hardwareConcurrency; });
  override('deviceMemory', function (c) { return c.deviceMemory; });
  override('languages', function (c) { return c.languages.slice(); });
  override('language', function (c) { return c.languages[0] || 'zh-CN'; });

  // ── Canvas：仅在被读取时给一小块像素加确定性噪声 ──────────────────
  var _toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    var c = current();
    if (c && c.canvasSeed && this.width > 0 && this.height > 0 && this.__hiraFpSeed !== c.canvasSeed) {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var w = Math.min(this.width, 16);
          var h = Math.min(this.height, 16);
          var img = ctx.getImageData(0, 0, w, h);
          var d = img.data;
          for (var i = 0; i < d.length; i += 4) {
            d[i] = Math.max(0, Math.min(255, d[i] + ((c.canvasSeed >> 3) & 1) - 1));
          }
          ctx.putImageData(img, 0, 0);
          this.__hiraFpSeed = c.canvasSeed;
        }
      } catch (e) {}
    }
    return _toDataURL.apply(this, arguments);
  };

  // ── WebGL：UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL ─────────
  var VENDOR = 37445, RENDERER = 37446;
  function patchWebGL(proto) {
    if (!proto || !proto.getParameter) return;
    var original = proto.getParameter;
    proto.getParameter = function (p) {
      var c = current();
      if (c) {
        if (p === VENDOR && c.webglVendor) return c.webglVendor;
        if (p === RENDERER && c.webglRenderer) return c.webglRenderer;
      }
      return original.apply(this, arguments);
    };
  }
  try { patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
  try { patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}

  // ── Audio：频域数据加极小扰动（指纹取的是位模式差异）─────────────
  try {
    if (window.AnalyserNode) {
      var _getFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
        var r = _getFloat.apply(this, arguments);
        var c = current();
        if (c && c.audioSeed && arr) {
          var delta = ((c.audioSeed >> 5) & 1) ? 0.0001 : -0.0001;
          for (var i = 0; i < arr.length; i++) arr[i] += delta;
        }
        return r;
      };
    }
  } catch (e) {}
})();`
}

export {
  FINGERPRINT_SETTING_KEY,
  FINGERPRINT_PLATFORM_OPTIONS,
  WEBGL_POOL,
  CORES_POOL,
  MEMORY_POOL,
  normalizeFingerprint,
  normalizeLanguages,
  generateFingerprint,
  buildFingerprintScript
}

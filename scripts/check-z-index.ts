#!/usr/bin/env node
/**
 * 渲染层 z-index 门禁（Layer Styles Guard）
 *
 * 规则：渲染层源码里**不允许出现裸的 z-index 数字**。
 *   裸数字指的是把 z-index 直接写死成数值，例如：
 *     - CSS / innerHTML / cssText：`z-index: 123`
 *     - JS 对象 / DOM 赋值：        `zIndex: 123` / `style.zIndex = '123'`
 *   正确写法（取值同源，见 packages/shared-ui-tokens/layers.css）：
 *     - CSS：`z-index: var(--hira-z-<layer>)` 或工具类 `.hira-z-<layer>`
 *     - JS ：`import { UILayer } from '@hira-ng/shared-ui-tokens'` 后取层名常量
 *
 * 为什么是纯 Node 而不是 grep/wc：
 *   与 `apps/app-main/src/main/verification/p0-check.js` 同一教训 —— Windows 上
 *   没有 grep/wc，`execSync` 会静默返回 0，于是「永远绿」比没有校验更危险。
 *   这里用纯 Node 目录遍历 + 逐行正则，跨平台一致，命中行原样打印。
 *
 * 白名单（放行但打印提醒，避免“悄悄放行”）：
 *   1. 值为 0 —— 默认层，写不写数字都不改变层叠结果；
 *   2. 带 `TODO(layer)` 注释的行 —— 已在 layers.css / 门禁报告中登记的待确认项。
 *
 * 用法：node scripts/check-z-index.cjs
 * 退出码：有违规 → 1；否则 → 0。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** 检查范围（渲染层相关目录，相对 ROOT）。 */
const SCOPES = ['ui', 'apps/app-main/src/renderer', 'apps/app-main/src/pages']

/** 不进入的目录：构建产物 / 依赖 / 第三方游戏代码。 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'external', 'build', 'patches'])

/** 只扫这些扩展名（渲染层可能承载 z-index 的全部载体）。 */
const SCAN_EXTS = /\.(js|cjs|mjs|ts|tsx|jsx|css|scss|less|html)$/i

/** CSS / 内联样式串里的 `z-index: <数字>`。 */
const RE_CSS_Z = /z-index\s*:\s*['"]?\s*(-?\d+)/gi
/** JS 里 `zIndex: 数字` / `zIndex = 数字|'数字'` 的赋值与字面量。 */
const RE_JS_Z = /zIndex\s*[:=]\s*['"]?(-?\d+)/g
/** 已登记的待确认项标记（放行但提醒）。 */
const RE_TODO_LAYER = /TODO\(layer\)/

const violations: string[] = []
const whitelistZero: string[] = []
const whitelistTodo: string[] = []

/** 纯 Node 递归遍历（跨平台，不依赖 grep/wc/find）。 */
function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (SCAN_EXTS.test(e.name)) out.push(full)
  }
  return out
}

function rel(abs: string): string {
  return path.relative(ROOT, abs).replace(/\\/g, '/')
}

function scanFile(file: string): void {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_) {
    return
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('z-index') && !line.includes('zIndex')) continue

    const values: Array<{ raw: string; value: number }> = []
    for (const re of [RE_CSS_Z, RE_JS_Z]) {
      re.lastIndex = 0
      let m
      // 一行里可能既有 CSS 也有 JS（如 cssText 拼接），全部收出来逐个判定
      while ((m = re.exec(line))) values.push({ raw: m[0], value: Number(m[1]) })
    }
    if (!values.length) continue

    const hit = `${rel(file)}:${i + 1}: ${line.trim()}`
    // 一行内只要存在「非 0 的裸数字」且没有 TODO 标记，才判违规
    const naked = values.filter((v) => v.value !== 0)
    if (naked.length === 0) {
      whitelistZero.push(hit)
    } else if (RE_TODO_LAYER.test(line)) {
      whitelistTodo.push(hit)
    } else {
      violations.push(hit)
    }
  }
}

function main() {
  const files: string[] = []
  for (const scope of SCOPES) files.push(...walk(path.join(ROOT, scope)))
  for (const f of files) scanFile(f)

  console.log('══ 渲染层 z-index 门禁 ══════════════════════════════════')
  console.log(`扫描目录：${SCOPES.join(', ')}`)
  console.log(`扫描文件：${files.length} 个`)
  console.log('')

  if (whitelistTodo.length) {
    console.log(`⚠ 白名单（带 TODO(layer)，待确认语义层，已放行 ${whitelistTodo.length} 处）：`)
    for (const h of whitelistTodo) console.log(`  ${h}`)
    console.log('')
  }
  if (whitelistZero.length) {
    console.log(`ℹ 白名单（值为 0，默认层，已放行 ${whitelistZero.length} 处）：`)
    for (const h of whitelistZero) console.log(`  ${h}`)
    console.log('')
  }

  if (violations.length) {
    console.log(`✗ 发现 ${violations.length} 处裸的 z-index 数字：`)
    for (const h of violations) console.log(`  ${h}`)
    console.log('')
    console.log('  改用语义层：CSS 用 var(--hira-z-<layer>) / .hira-z-<layer>，')
    console.log('  JS 用 import { UILayer } from \'@hira-ng/shared-ui-tokens\'。')
    console.log('  若确实无法归类：保留原值并加注释 /* TODO(layer): 待确认语义层 —— 原值 N */。')
    console.log('')
    console.log(`违规总数：${violations.length}`)
    process.exit(1)
  }

  console.log('✓ 未发现裸的 z-index 数字，全部走语义层 token。')
  console.log(`违规总数：0   白名单放行：${whitelistZero.length + whitelistTodo.length}`)
  process.exit(0)
}

main()

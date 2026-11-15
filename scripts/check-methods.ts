#!/usr/bin/env node
/**
 * 静态检查：**直接调在 `this` 上的私有方法是否真的存在**。
 *
 * ── 为什么需要它（真实事故驱动）──────────────────────────────────────────
 * 分屏落地时 `LayoutCoordinator.applyInitialLayout` 里调了一个 `this._hideSplitDivider()`，
 * 而那个方法在"分隔条改成外壳 DOM"时被删掉了、调用点漏删。
 * 结果：**lint 干净、三个验证脚本全绿、构建通过**，一启动就
 * `TypeError: this._hideSplitDivider is not a function` → 主进程致命退出。
 *
 * 原因很具体：`no-undef` 不认识"类方法的成员访问"，而旧仓库缺少真正的成员类型检查，
 * 于是这一类错误**没有任何一道门禁能拦住它**。而它的代价是"整个应用起不来"。
 *
 * ── 判据与边界 ────────────────────────────────────────────────────────
 * 只查 `this._name(`（左括号紧跟其后）。因此以下都**不在**射程内，天然无误报：
 *   · `this._wcm.getTab()`   —— `getTab` 是别的对象的成员，不是本类的方法；
 *   · `this._layers.reallocateFocus()` —— 同理。
 * 命中的名字必须在**同一个文件**里出现过定义，形式任一种都算：
 *   · `  _name(`（类方法 / 简写方法）
 *   · `this._name =`（构造里挂的函数）
 *   · `_name:` / `_name =`（对象字面量里的方法，例如 mixin）
 *
 * 退出码 0 = 全部有定义。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_DIRS = ['infra', 'domain', 'ui', 'packages', 'apps']

/**
 * 跳过 node_modules / 产物 / 测试产物 / **vendored 第三方 bundle**。
 * `external` 里是原样打包进来的第三方 JS（例如游戏用的 React chunk），
 * 它们的成员定义方式（压缩 + 原型赋值）不是本检查能解析的形态，也不在我们的维护范围。
 */
const SKIP = new Set(['node_modules', 'out', 'dist', 'coverage', '.git', 'output', 'fixtures', 'external'])

function walk(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** `this._name(` 的出现（不跨行）。 */
const CALL_RE = /\bthis\.(_[A-Za-z_$][\w$]*)\s*\(/g

/** 该名字在本文件里是否有定义。 */
function isDefined(src: string, name: string): boolean {
  const esc = name.replace(/[$]/g, '\\$')
  const patterns = [
    // 类方法 / 简写方法：行首缩进 + 名字 + (
    new RegExp(`^\\s{1,8}${esc}[^\\n(]*\\(`, 'm'),
    // 构造里挂的：this._name =
    new RegExp(`\\bthis\\.${esc}\\s*=`, 'm'),
    // 对象字面量里的方法 / 属性：_name: 或 _name =（含 `_name (` 这种带空格写法）
    new RegExp(`(^|[\\s{,])${esc}\\s*[:(=]`, 'm')
  ]
  return patterns.some((re) => re.test(src))
}

const files: string[] = []
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir)
  if (fs.existsSync(abs)) walk(abs, files)
}

let problems = 0
let scanned = 0
for (const file of files) {
  let src = ''
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch (_) {
    continue
  }
  scanned++
  const missing = new Set<string>()
  CALL_RE.lastIndex = 0
  let m
  while ((m = CALL_RE.exec(src)) !== null) {
    const name = m[1]
    if (!isDefined(src, name)) missing.add(name)
  }
  if (missing.size > 0) {
    problems += missing.size
    const rel = path.relative(ROOT, file)
    for (const name of missing) console.log(`  ✗ ${rel}  调用了未定义的 this.${name}()`)
  }
}

console.log('')
console.log(`扫描 ${scanned} 个文件 · 未定义的方法调用 ${problems} 处`)
if (problems > 0) {
  console.log('（这一类错误没有任何别的门禁能拦住：lint 不查类成员，构建也不查）')
  process.exitCode = 1
} else {
  console.log('全部有定义 ✓')
}

#!/usr/bin/env node
/**
 * 内部页**模块图**门禁：`hira://` 内部页是不打包的静态页（协议直读磁盘，
 * 没有打包器、没有 workspace 解析、没有 import maps），所以它里面每一个
 * import 说明符都必须能直接落成一个真实 URL。落不下 = **整页白屏** ——
 * 因为失败的是入口模块，整张模块图一个都不执行，而页面外壳本身也是 JS 生成的。
 *
 * 检查三件事（前两类是**错误**，会让页面白屏；第三类只是提示）：
 *   1. 裸模块名（`@hira-ng/...`、`react`…）—— 浏览器解析不了。
 *      例外：源码里写共享层裸名是**允许**的，构建时会由
 *      electron.vite.config.js#rewriteSharedSpecifiers 改写成 `hira://shared/…`；
 *      所以这里只看**构建产物**（out/pages），产物里还有裸名就是真错。
 *   2. 相对路径 / `hira://shared/…` 指向的文件不存在。
 *   3. `hira://<其它 host>/…` 不是磁盘页面 —— 那多半是协议里的**动态 host**
 *      （pdfjs / extension-icon / favicon …），无法静态判定，只提示不报错。
 *
 * 用法：
 *   node scripts/check-page-modules.cjs                 # 检查 out/pages 下全部页面
 *   node scripts/check-page-modules.cjs newtab          # 只检查某一个页面
 *   node scripts/check-page-modules.cjs <root> <page>   # 指定仓库根与页面名
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

const ROOT = process.argv[2] && fs.existsSync(process.argv[2]) ? path.resolve(process.argv[2]) : process.cwd()
const ONLY = process.argv[3] || process.argv[2] || ''
const PAGES_DIR = path.join(ROOT, 'out/pages')
const SHARED_DIR = path.join(PAGES_DIR, '_shared')

/** 说明符 → 磁盘路径；返回 null 表示**裸模块名**（页面里必然失败）。 */
function resolveSpec(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
  if (spec.startsWith('hira://')) {
    const rest = spec.slice('hira://'.length)
    const cut = rest.indexOf('/')
    const host = cut < 0 ? rest : rest.slice(0, cut)
    const tail = cut < 0 ? '' : rest.slice(cut + 1)
    const dir = host === 'shared' ? SHARED_DIR : path.join(PAGES_DIR, host)
    return path.join(dir, tail)
  }
  if (spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null // 其它协议：交给运行时
  return null
}

/**
 * 从模块源码里取出所有说明符。
 *
 * 用 TypeScript AST 而不是文本正则：字符串字面量里出现的 "import" / "from"
 * 是普通内容，不能当成模块说明符（否则 `"bookmark import"` 会误报整个页面）。
 */
function collectSpecs(code: string): string[] {
  const specs: string[] = []
  const source = ts.createSourceFile('page-module.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [request] = node.arguments
      if (request && ts.isStringLiteralLike(request)) specs.push(request.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specs
}

function checkPage(pageName: string): { pageName: string; modules: number; errors: string[]; notes: string[] } | null {
  const entry = path.join(PAGES_DIR, pageName, 'index.html')
  if (!fs.existsSync(entry)) return null

  const html = fs.readFileSync(entry, 'utf8')
  const queue: string[] = []
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) {
    const source = m[1]
    if (source) queue.push(path.resolve(path.dirname(entry), source))
  }

  const seen = new Set<string>()
  const errors: string[] = []
  const notes: string[] = []

  while (queue.length) {
    const file = queue.pop()
    if (file === undefined) break
    if (seen.has(file)) continue
    seen.add(file)
    const where = path.relative(ROOT, file)
    if (!fs.existsSync(file)) {
      errors.push(`[文件缺失] ${where}`)
      continue
    }
    const code = fs.readFileSync(file, 'utf8')
    for (const spec of collectSpecs(code)) {
      const target = resolveSpec(spec, file)
      if (target === null) {
        errors.push(`[裸模块名] ${where} → ${spec}`)
        continue
      }
      if (!fs.existsSync(target)) {
        const dynamic = spec.startsWith('hira://') && !spec.startsWith('hira://shared/')
        const msg = `${where} → ${spec}`
        if (dynamic) notes.push(msg)
        else errors.push(`[文件缺失] ${msg}`)
        continue
      }
      if (/\.(mjs|cjs|js)$/i.test(target)) queue.push(target)
    }
  }
  return { pageName, modules: seen.size, errors, notes }
}

const pages = ONLY
  ? [ONLY]
  : fs
      .readdirSync(PAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort()

let failed = 0
for (const name of pages) {
  const result = checkPage(name)
  if (!result) continue
  const { modules, errors, notes } = result
  if (errors.length === 0) {
    console.log(`✓ ${name} · ${modules} 个模块 · 说明符全部可解析`)
  } else {
    failed++
    console.log(`✗ ${name} · ${modules} 个模块 · ${errors.length} 处问题`)
    for (const e of errors) console.log(`    ${e}`)
    console.log('    ⚠ 页面是不打包的静态页：任一处解析不了都会导致**整页白屏**（不是少个组件）。')
    console.log('      共享层模块请登记进 electron.vite.config.js 的 SHARED_PAGES_MODULES / _DIRS / _ASSETS，')
    console.log('      源码里可继续写裸名，构建时会自动改写成 hira://shared/…。')
  }
  for (const n of notes) console.log(`    · 动态 host（静态期无法判定，已跳过）：${n}`)
}

if (failed > 0) {
  console.log(`\n违规页面：${failed}`)
  process.exitCode = 1
} else {
  console.log('\n全部内部页模块图 OK')
}

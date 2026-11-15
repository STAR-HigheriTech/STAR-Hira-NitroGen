#!/usr/bin/env node
/**
 * 分层依赖门禁（Layer Guard）
 *
 * 依据 docs-ng/PART3 §3.5：
 *   R1 只能同层或下一层依赖：APPS → UI → DOMAIN → INFRA（PACKAGES 任意层可依赖）
 *   R2 同层可互相依赖，但禁止循环
 *   R3 黑名单：domain/ui 不得 require electron / fs / path（必须走 infra 接口），
 *              不得直接读 process.platform（必须走 infra-platform）
 *
 * 为什么是「棘轮」而不是「一票否决」：
 *   现在（重构前）违规必然超标，一把清零不现实。所以用基线文件锁住当前水位，
 *   每完成一步下沉就把基线压下去。**只许降不许升**，重构才不会烂尾。
 *
 * 用法：
 *   node scripts/check-layers.cjs                  # 对比基线，超标即 exit 1
 *   node scripts/check-layers.cjs --verbose        # 打印全部违规明细
 *   node scripts/check-layers.cjs --update-baseline # 把当前水位写成新基线
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asRecord, stringOf } from './lib/type-guards.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_FILE = path.join(ROOT, '.hira-ai', 'layer-baseline.json')

const WORKSPACE_DIRS = ['apps', 'ui', 'domain', 'infra', 'packages'] as const
type Layer = typeof WORKSPACE_DIRS[number]

interface PackageInfo {
  dir: string
  name: string
  ws: Layer
  layer: Layer
}

interface Violation {
  rule: string
  message: string
  file: string
  line: number
}

interface DependencyEdge {
  from: PackageInfo
  to: PackageInfo
  file: string
  line: number
}
// 第三方静态 bundle（上游游戏等）不受我们的分层约束
const SKIP_DIR_SEGMENTS = ['node_modules', 'out', 'dist', 'external', '.git']

const LAYER_OF_WORKSPACE: Record<Layer, Layer> = { apps: 'apps', ui: 'ui', domain: 'domain', infra: 'infra', packages: 'packages' }

// R1：谁可以依赖谁
const ALLOWED: Record<Layer, readonly Layer[]> = {
  apps: ['apps', 'ui', 'domain', 'infra', 'packages'],
  ui: ['ui', 'domain', 'infra', 'packages'],
  domain: ['domain', 'infra', 'packages'],
  infra: ['infra', 'packages'],
  packages: ['packages']
}

// R3：domain / ui 层禁止直接 require 的技术模块
const BANNED_MODULES: Partial<Record<Layer, readonly string[]>> = {
  domain: ['electron', 'fs', 'fs/promises', 'path', 'child_process', 'os'],
  ui: ['electron', 'fs', 'fs/promises', 'path', 'child_process', 'os']
}
const NODE_BUILTIN = new Set(['fs', 'fs/promises', 'path', 'child_process', 'os', 'net', 'http', 'https', 'crypto', 'url'])
void NODE_BUILTIN // 预留：后续可加"npm 依赖必须声明在 package.json"的检查

function stripBuiltinPrefix(spec: string): string {
  return spec.startsWith('node:') ? spec.slice(5) : spec
}

// ── 1. 收集工作区包 ────────────────────────────────────────────
function listPackages(): PackageInfo[] {
  const packages: PackageInfo[] = []
  for (const ws of WORKSPACE_DIRS) {
    const wsDir = path.join(ROOT, ws)
    if (!fs.existsSync(wsDir)) continue
    for (const name of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, name)
      const pkgJson = path.join(dir, 'package.json')
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(pkgJson)) continue
      let pkgName: string | null = null
      try {
        const parsed = asRecord(JSON.parse(fs.readFileSync(pkgJson, 'utf8')))
        pkgName = stringOf(parsed.name) || null
      } catch {}
      packages.push({ dir, name: pkgName || `${ws}/${name}`, ws, layer: LAYER_OF_WORKSPACE[ws] })
    }
  }
  return packages
}

const PACKAGES = listPackages()
const BY_NAME = new Map<string, PackageInfo>()
for (const p of PACKAGES) if (p.name) BY_NAME.set(p.name, p)

/** 找到包含某绝对路径的包（取最长前缀） */
function packageOf(absPath: string): PackageInfo | null {
  let best: PackageInfo | null = null
  for (const p of PACKAGES) {
    const d = p.dir + path.sep
    if ((absPath + path.sep).startsWith(d) && (!best || p.dir.length > best.dir.length)) best = p
  }
  return best
}

/** 把 bare specifier 解析成工作区包（支持 @hira-ng/x/sub 子路径） */
function resolveSpecifier(spec: string): PackageInfo | null {
  if (spec.startsWith('@hira-ng/')) {
    const parts = spec.split('/')
    const name = parts.slice(0, 2).join('/')
    return BY_NAME.get(name) || null
  }
  return BY_NAME.get(spec) || null
}

// ── 2. 逐文件扫描 ──────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIR_SEGMENTS.includes(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(js|cjs|mjs|ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

/**
 * 去掉注释但保留字符串 —— 朴素地整行删 `//` 会把
 * `require('x') // https://a` 这类行里的代码也吃掉/误伤，所以走一个小状态机。
 */
function stripComments(src: readonly string[]): string[] {
  const out: string[] = []
  let inBlock = false
  let inS: '"' | "'" | '`' | null = null // ' " `
  for (let li = 0; li < src.length; li++) {
    const line = src[li]
    let res = ''
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      const n = line[i + 1]
      if (inBlock) {
        if (c === '*' && n === '/') { inBlock = false; i++ }
        continue
      }
      if (inS) {
        res += c
        if (c === '\\') { res += n ?? ''; i++; continue }
        if (c === inS) inS = null
        continue
      }
      if (c === '/' && n === '*') { inBlock = true; i++; continue }
      if (c === '/' && n === '/') break
      if (c === '"' || c === "'" || c === '`') { inS = c; res += c; continue }
      res += c
    }
    out.push(res)
  }
  return out
}

const RE_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_FROM = /\bfrom\s+['"]([^'"]+)['"]/g
const RE_DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_SIDE_IMPORT = /\bimport\s+['"]([^'"]+)['"]/g
const RE_PROCESS_PLATFORM = /\bprocess\.platform\b/

function scan(): { violations: Violation[]; edges: DependencyEdge[] } {
  const violations: Violation[] = []
  const edges: DependencyEdge[] = []
  const add = (rule: string, message: string, file: string, line: number): void => {
    violations.push({ rule, message, file: path.relative(ROOT, file).replace(/\\/g, '/'), line })
  }

  for (const pkg of PACKAGES) {
    const srcDir = path.join(pkg.dir, 'src')
    if (!fs.existsSync(srcDir)) continue
    for (const file of walk(srcDir)) {
      // 测试文件跑在 Node 里、不属于运行时分层，允许用 node 内建模块建临时目录。
      // 但分层方向（R1）与循环（R2）对测试同样生效 —— 测试也不该反向依赖。
      const isTest = /\.test\.(mjs|cjs|js|ts|tsx)$/.test(file)
      const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      const lines = stripComments(raw)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const lineNo = i + 1

        // R3：process.platform 直读
        if (!isTest && (pkg.layer === 'domain' || pkg.layer === 'ui') && RE_PROCESS_PLATFORM.test(line)) {
          add('R3-process-platform', `${pkg.name} 直接读 process.platform（应走 infra-platform）`, file, lineNo)
        }

        const specs: string[] = []
        for (const re of [RE_REQUIRE, RE_FROM, RE_DYNAMIC_IMPORT, RE_SIDE_IMPORT]) {
          re.lastIndex = 0
          let m
          while ((m = re.exec(line))) specs.push(m[1])
        }

        for (const spec of specs) {
          // 相对路径 → 判断是否越出当前包
          if (spec.startsWith('.')) {
            const abs = path.resolve(path.dirname(file), spec)
          const target = packageOf(abs)
          if (target) {
              if (target.name !== pkg.name) {
                edges.push({ from: pkg, to: target, file, line: lineNo })
                if (!ALLOWED[pkg.layer].includes(target.layer)) {
                  add('R1-direction', `${pkg.layer} → ${target.layer}（${pkg.name} → ${target.name}）越层依赖`, file, lineNo)
                }
              }
            } else {
              add('R1-escape', `相对引用逃出工作区包：${spec}`, file, lineNo)
            }
            continue
          }

          const target = resolveSpecifier(spec)
          if (target) {
            edges.push({ from: pkg, to: target, file, line: lineNo })
            if (target.name === pkg.name) continue
            if (!ALLOWED[pkg.layer].includes(target.layer)) {
              add('R1-direction', `${pkg.layer} → ${target.layer}（${pkg.name} → ${target.name}）越层依赖`, file, lineNo)
            }
            continue
          }

          // 外部模块（node builtin / npm）
          const bare = stripBuiltinPrefix(spec)
          const banned = BANNED_MODULES[pkg.layer]
          if (!isTest && banned && banned.includes(bare)) {
            add('R3-banned-module', `${pkg.name} 直接 require('${spec}')（应走 infra 注入）`, file, lineNo)
          }
        }
      }
    }
  }
  return { violations, edges }
}

// ── 3. 同层循环检测（R2）───────────────────────────────────────
function detectCycles(edges: DependencyEdge[]): string[] {
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    if (e.from.name === e.to.name) continue
    if (e.from.layer !== e.to.layer) continue // 只有同层才可能"循环"
    if (!adj.has(e.from.name)) adj.set(e.from.name, new Set())
    adj.get(e.from.name)?.add(e.to.name)
  }
  const cycles: string[] = []
  const state = new Map<string, 1 | 2>() // 1=栈中 2=完成
  const stack: string[] = []
  function dfs(node: string): void {
    state.set(node, 1)
    stack.push(node)
    for (const next of adj.get(node) || []) {
      if (state.get(next) === 1) {
        const idx = stack.indexOf(next)
        cycles.push([...stack.slice(idx), next].join(' -> '))
      } else if (!state.has(next)) {
        dfs(next)
      }
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const node of adj.keys()) if (!state.has(node)) dfs(node)
  return [...new Set(cycles)]
}

// ── 4. 基线与输出 ──────────────────────────────────────────────
const { violations, edges } = scan()
const cycles = detectCycles(edges)
for (const c of cycles) {
  violations.push({ rule: 'R2-cycle', message: `同层循环依赖：${c}`, file: '-', line: 0 })
}

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const updateBaseline = args.includes('--update-baseline')

const byRule: Record<string, number> = {}
const byPackage: Record<string, number> = {}
for (const v of violations) {
  byRule[v.rule] = (byRule[v.rule] || 0) + 1
  const pkg = v.file.split('/').slice(0, 2).join('/')
  byPackage[pkg] = (byPackage[pkg] || 0) + 1
}

const total = violations.length
interface LayerBaseline { total: number; byRule?: Record<string, number> }
let baseline: LayerBaseline | null = null
if (fs.existsSync(BASELINE_FILE)) {
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')))
    if (typeof parsed.total === 'number') baseline = { total: parsed.total, byRule: asRecord(parsed.byRule) as Record<string, number> }
  } catch {}
}

function pct(from: number, to: number): string {
  if (!from) return '—'
  const d = ((to - from) / from) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

console.log('══ 分层依赖门禁 ══════════════════════════════════════')
console.log(`扫描包：${PACKAGES.length} 个`)
console.log('')
console.log('按规则：')
for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(20)} ${String(n).padStart(4)}`)
}
console.log('')
console.log('Top 违规包：')
for (const [pkg, n] of Object.entries(byPackage).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${pkg.padEnd(32)} ${String(n).padStart(4)}`)
}
console.log('')
console.log(`违规总数：${total}${baseline ? `   基线：${baseline.total}   变化：${pct(baseline.total, total)}` : '（尚无基线）'}`)

if (verbose) {
  console.log('\n──── 明细 ────')
  for (const v of violations) {
    console.log(`[${v.rule}] ${v.file}:${v.line}  ${v.message}`)
  }
}

if (updateBaseline) {
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    total,
    byRule,
    updatedAt: new Date().toISOString().slice(0, 10)
  }, null, 2) + '\n', 'utf8')
  console.log(`\n已写入基线：${path.relative(ROOT, BASELINE_FILE)}`)
  process.exit(0)
}

if (baseline && total > baseline.total) {
  console.log(`\n✗ 违规数高于基线（${total} > ${baseline.total}）—— 重构不允许倒退。`)
  console.log('  如果这确实是"新包还没接线"的中间态，请说明原因后再跑 --update-baseline。')
  process.exit(1)
}
console.log('\n✓ 未高于基线。')

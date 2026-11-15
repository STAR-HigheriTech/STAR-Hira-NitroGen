import * as fs from 'node:fs'
import * as path from 'node:path'

interface CatalogBinding {
  kind?: string
  package?: string
  capability?: string
  method?: string
  field?: string
  channel?: string
}

interface CatalogFunction {
  ng?: CatalogBinding
}

interface CatalogFile {
  functions: CatalogFunction[]
}

type SurfaceMap = Record<string, string[]>

const root = path.resolve(__dirname, '..')
const catalogPath = path.join(root, '.hira-ai', 'l1-functions.json')

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function extractReturnedKeys(source: string): Set<string> {
  const keys = new Set<string>()
  const re = /return\s*\{/g
  let match
  while ((match = re.exec(source))) {
    let depth = 0
    let i = match.index + match[0].length - 1
    const start = i
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = source.slice(start + 1, i)
    const keyRe = /(?:^|[,{\n])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:[,:(]|\n)/g
    let keyMatch
    while ((keyMatch = keyRe.exec(body))) keys.add(keyMatch[1])
  }
  return keys
}

function scanPackages(baseDir: string, prefixFilter?: string): SurfaceMap {
  const result: SurfaceMap = {}
  if (!fs.existsSync(baseDir)) return result
  for (const name of fs.readdirSync(baseDir)) {
    if (prefixFilter && !name.startsWith(prefixFilter)) continue
    const srcDir = path.join(baseDir, name, 'src')
    if (!fs.existsSync(srcDir)) continue
    const keys = new Set<string>()
    for (const file of walk(srcDir)) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file) || /\.(?:test|spec)\./.test(file)) continue
      for (const key of extractReturnedKeys(fs.readFileSync(file, 'utf8'))) keys.add(key)
    }
    result[name] = [...keys].sort()
  }
  return result
}

function scanPlugins(): SurfaceMap {
  const dir = path.join(root, 'apps', 'app-main', 'plugins')
  const result: SurfaceMap = {}
  if (!fs.existsSync(dir)) return result
  for (const file of fs.readdirSync(dir)) {
    if (!/-(?:service|provider)\.(?:ts|cts|mts)$/.test(file)) continue
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    const caps = new Set<string>()
    const re = /['"]([a-zA-Z][\w-]*\.[\w.]+)['"]\s*:\s*(?:async\s*)?\(/g
    let match
    while ((match = re.exec(source))) caps.add(match[1])
    result[file.replace(/\.(?:ts|cts|mts)$/, '')] = [...caps].sort()
  }
  return result
}

function scanIpcChannels(): string[] {
  const channels = new Set<string>()
  for (const file of walk(path.join(root, 'apps')).concat(walk(path.join(root, 'infra')))) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue
    if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    const re = /['"`]((?:hira|app|tabs|bookmark|history|download|session|password|permission|search|profile|settings|extensions|keybindings|games|window|ui)[a-z0-9]*[:.][a-zA-Z0-9:._-]+)['"`]/g
    let match
    while ((match = re.exec(source))) channels.add(match[1])
  }
  return [...channels].sort()
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogFile
const registered = new Set<string>()
for (const fn of catalog.functions) {
  const ng = fn.ng || {}
  registered.add([ng.kind, ng.package || ng.capability, ng.method, ng.field, ng.channel].filter(Boolean).join('|'))
}

const domains = scanPackages(path.join(root, 'domain'))
const infras = scanPackages(path.join(root, 'infra'))
const plugins = scanPlugins()
const ipc = scanIpcChannels()

const registeredMethods = new Set<string>()
const registeredCaps = new Set<string>()
for (const fn of catalog.functions) {
  const ng = fn.ng || {}
  if (ng.package && ng.method) registeredMethods.add(`${ng.package}|${ng.method}`)
  if (ng.capability) registeredCaps.add(ng.capability)
}

function pending(map: SurfaceMap): SurfaceMap {
  const out: SurfaceMap = {}
  for (const [pkg, methods] of Object.entries(map)) {
    const rest = methods.filter((m) => !registeredMethods.has(`${pkg}|${m}`))
    if (rest.length) out[pkg] = rest
  }
  return out
}

const pendingDomain = pending(domains)
const pendingInfra = pending(infras)
const pendingCaps: SurfaceMap = {}
for (const [name, caps] of Object.entries(plugins)) {
  const rest = caps.filter((c) => !registeredCaps.has(c))
  if (rest.length) pendingCaps[name] = rest
}

const countValues = (obj: SurfaceMap): number => Object.values(obj).reduce((sum, list) => sum + list.length, 0)

const summary = {
  registeredBindings: registered.size,
  domain: Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, v.length])),
  infra: Object.fromEntries(Object.entries(infras).map(([k, v]) => [k, v.length])),
  plugins: Object.fromEntries(Object.entries(plugins).map(([k, v]) => [k, v.length])),
  ipcChannels: ipc.length,
  pendingDomainMethods: countValues(pendingDomain),
  pendingInfraMethods: countValues(pendingInfra),
  pendingCapabilities: countValues(pendingCaps),
  pendingDomainByPackage: Object.fromEntries(Object.entries(pendingDomain).map(([k, v]) => [k, v.length])),
  pendingInfraByPackage: Object.fromEntries(Object.entries(pendingInfra).map(([k, v]) => [k, v.length]))
}

const detail = { domains, infras, plugins, ipc, pendingDomain, pendingInfra, pendingCaps }
fs.writeFileSync(path.join(root, '.hira-ai', 'ng-surface-scan.json'), `${JSON.stringify(detail, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(summary, null, 2))

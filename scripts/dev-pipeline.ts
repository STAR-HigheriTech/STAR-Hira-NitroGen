#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { availableParallelism } from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch, type FSWatcher } from 'chokidar'
import { errorMessage } from './lib/type-guards.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ROOTS = ['packages', 'domain', 'infra'] as const
const PLUGIN_SOURCE_DIR = path.join(ROOT, 'apps', 'app-main', 'plugins')
const PLUGIN_OUTPUT_DIR = path.join(ROOT, 'build', 'plugins')
const APP_MAIN_ENTRY = path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'main.ts')
const APP_SOURCE_WATCH_DIRS = [
  path.join(ROOT, 'apps', 'app-main', 'src', 'main'),
  path.join(ROOT, 'apps', 'app-main', 'src', 'pages'),
  path.join(ROOT, 'apps', 'app-main', 'src', 'preload')
] as const
const PLUGIN_TOOL_FILES = [
  path.join(ROOT, 'scripts', 'build-plugins.ts'),
  path.join(ROOT, 'scripts', 'lib', 'type-guards.ts')
]
const CACHE_DIR = path.join(ROOT, '.cache')
const CACHE_FILE = path.join(CACHE_DIR, 'hira-dev-pipeline.json')
const CACHE_VERSION = 5
const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024
const DEFAULT_CONCURRENCY = Math.max(2, Math.min(8, availableParallelism()))

interface PackageManifest {
  name?: string
  main?: string
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

interface WorkspacePackage {
  name: string
  directory: string
  manifest: PackageManifest
  buildCommand: string
  dependencies: Set<string>
  dependents: Set<string>
}

interface CacheEntry {
  fingerprint: string
  builtAt: number
}

interface CacheState {
  version: number
  nodeMajor: number
  toolchainFingerprint: string
  packages: Record<string, CacheEntry>
  plugins?: CacheEntry
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
  durationMs: number
}

interface PipelineOptions {
  force: boolean
  concurrency: number
  electronArgs: string[]
}

interface Runtime {
  packages: WorkspacePackage[]
  packagesByName: Map<string, WorkspacePackage>
  cache: CacheState
  activeChildren: Set<ChildProcess>
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`)
}

/** 5173 由 electron-vite 固定；先探测可把端口冲突变成可操作提示，而不是启动到一半才由 Vite 抛错。 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(600, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function environmentFor(cwd: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const executableDirs = [path.join(cwd, 'node_modules', '.bin'), path.join(ROOT, 'node_modules', '.bin')]
  return {
    ...process.env,
    [pathKey]: [...executableDirs, process.env[pathKey]].filter(Boolean).join(path.delimiter)
  }
}

function parseOptions(argv: string[]): PipelineOptions {
  let force = false
  let concurrency = DEFAULT_CONCURRENCY
  const electronArgs: string[] = []
  let afterSeparator = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') {
      afterSeparator = true
      continue
    }
    if (afterSeparator) {
      electronArgs.push(arg)
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--jobs' || arg === '--concurrency') {
      const raw = argv[++index]
      if (!raw) throw new Error(`${arg} 需要一个并发数`)
      concurrency = Number.parseInt(raw, 10)
      continue
    }
    if (arg.startsWith('--jobs=') || arg.startsWith('--concurrency=')) {
      concurrency = Number.parseInt(arg.slice(arg.indexOf('=') + 1), 10)
    }
  }

  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数')
  return { force, concurrency, electronArgs }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function toolchainFingerprint(): Promise<string> {
  const hash = createHash('sha256')
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
    hash.update(file)
    hash.update(await fs.readFile(path.join(ROOT, file), 'utf8'))
  }
  hash.update(process.versions.node)
  return hash.digest('hex')
}

async function loadCache(): Promise<CacheState> {
  const state = await readJson<CacheState>(CACHE_FILE)
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  const toolchain = await toolchainFingerprint()
  if (!state || state.version !== CACHE_VERSION || state.nodeMajor !== nodeMajor || state.toolchainFingerprint !== toolchain) {
    return { version: CACHE_VERSION, nodeMajor, toolchainFingerprint: toolchain, packages: {} }
  }
  return state
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(fullPath)
      return entry.isFile() ? [fullPath] : []
    }))
    return files.flat()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function importedWorkspacePackages(file: string, source: string, packageNames: string[]): string[] {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(file)) return []
  const imports = new Set<string>()
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])(@hira-ng\/[^'"]+)\1/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2]
    const matchName = packageNames.find((name) => specifier === name || specifier.startsWith(`${name}/`))
    if (matchName) imports.add(matchName)
  }
  return [...imports]
}

async function discoverPackages(): Promise<WorkspacePackage[]> {
  const directories = (await Promise.all(PACKAGE_ROOTS.map((root) => listDirectories(path.join(ROOT, root))))).flat()
  const manifests = await Promise.all(directories.map(async (directory) => ({
    directory,
    manifest: await readJson<PackageManifest>(path.join(directory, 'package.json'))
  })))
  const buildable = manifests.filter((entry): entry is typeof entry & { manifest: PackageManifest } => (
    Boolean(entry.manifest?.name && entry.manifest.scripts?.build)
  ))
  const packageNames = buildable.map((entry) => entry.manifest.name!).sort((a, b) => b.length - a.length)

  const packages = await Promise.all(buildable.map(async ({ directory, manifest }) => {
    const declared = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }
    const dependencies = new Set(Object.keys(declared).filter((name) => packageNames.includes(name)))
    const sourceFiles = (await collectSourceFiles(path.join(directory, 'src')))
      .filter((file) => /\.(?:[cm]?[jt]sx?)$/i.test(file))
    await Promise.all(sourceFiles.map(async (file) => {
      const source = await fs.readFile(file, 'utf8')
      for (const name of importedWorkspacePackages(file, source, packageNames)) dependencies.add(name)
    }))
    dependencies.delete(manifest.name!)
    return {
      name: manifest.name!,
      directory,
      manifest,
      buildCommand: manifest.scripts!.build!,
      dependencies,
      dependents: new Set<string>()
    } satisfies WorkspacePackage
  }))

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) byName.get(dependency)?.dependents.add(pkg.name)
  }
  return packages
}

function assertAcyclic(packages: WorkspacePackage[]): void {
  const packageNames = new Set(packages.map((pkg) => pkg.name))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))

  const visit = (name: string, trail: string[]): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`workspace 构建图存在循环依赖：${[...trail, name].join(' → ')}`)
    visiting.add(name)
    for (const dependency of byName.get(name)?.dependencies || []) {
      if (packageNames.has(dependency)) visit(dependency, [...trail, name])
    }
    visiting.delete(name)
    visited.add(name)
  }
  for (const pkg of packages) visit(pkg.name, [])
}

async function fingerprintDirectory(directory: string, ignoredNames = new Set(['dist', 'node_modules', '.cache', '.git'])): Promise<string> {
  const hash = createHash('sha256')
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue
      const fullPath = path.join(current, entry.name)
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await visit(fullPath, childRelative)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const stat = await fs.stat(fullPath)
      // ctime 会随内容写回变化；同尺寸、恢复 mtime 的极端编辑也不会漏失效。
      hash.update(`${childRelative}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.mode}\n`)
    }
  }
  await visit(directory, '')
  return hash.digest('hex')
}

async function packageFingerprint(pkg: WorkspacePackage): Promise<string> {
  const hash = createHash('sha256')
  hash.update(`${process.versions.node}\0${pkg.buildCommand}\0`)
  hash.update(await fingerprintDirectory(pkg.directory))
  return hash.digest('hex')
}

async function pluginFingerprint(): Promise<string | null> {
  try {
    const stat = await fs.stat(PLUGIN_SOURCE_DIR)
    if (!stat.isDirectory()) return null
    const hash = createHash('sha256')
    hash.update(await fingerprintDirectory(PLUGIN_SOURCE_DIR, new Set(['node_modules', '.cache', '.git'])))
    for (const file of PLUGIN_TOOL_FILES) {
      hash.update(normalizePath(path.relative(ROOT, file)))
      hash.update(await fs.readFile(file, 'utf8'))
    }
    return hash.digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function staticExportPaths(value: unknown, paths: string[]): void {
  if (typeof value === 'string') {
    if (!value.includes('*') && /\.(?:c|m)?js$/.test(value)) paths.push(value.replace(/^\.\//, ''))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) staticExportPaths(item, paths)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) staticExportPaths(item, paths)
  }
}

async function hasBuildOutput(pkg: WorkspacePackage): Promise<boolean> {
  const outputs = new Set<string>()
  if (pkg.manifest.main) outputs.add(pkg.manifest.main)
  const exportedPaths: string[] = []
  staticExportPaths(pkg.manifest.exports, exportedPaths)
  for (const output of exportedPaths) outputs.add(output)
  if (!outputs.size) outputs.add('dist')
  for (const output of outputs) {
    try {
      await fs.stat(path.resolve(pkg.directory, output))
    } catch {
      return false
    }
  }
  return true
}

async function hasPluginOutput(): Promise<boolean> {
  try {
    return (await fs.readdir(PLUGIN_OUTPUT_DIR)).length > 0
  } catch {
    return false
  }
}

async function runCommand(
  command: string,
  cwd: string,
  runtime: Runtime,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  const startedAt = performance.now()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let capturedBytes = 0

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [], {
      cwd,
      env: { ...environmentFor(cwd), ...extraEnv },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    runtime.activeChildren.add(child)
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (capturedBytes >= MAX_CAPTURED_OUTPUT) return
      const size = Math.min(chunk.length, MAX_CAPTURED_OUTPUT - capturedBytes)
      target.push(chunk.subarray(0, size))
      capturedBytes += size
    }
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk))

    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      runtime.activeChildren.delete(child)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        durationMs: Math.round(performance.now() - startedAt)
      })
    }
    child.on('error', (error: Error) => {
      capture(stderr, Buffer.from(error.message))
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

function printCommandFailure(label: string, result: CommandResult): void {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  logError(`✗ ${label} (${result.durationMs}ms)`)
  if (output) logError(output)
}

let persistTail: Promise<void> = Promise.resolve()

async function persistCache(runtime: Runtime): Promise<void> {
  const snapshot = JSON.stringify(runtime.cache, null, 2)
  persistTail = persistTail.then(async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    const temporary = `${CACHE_FILE}.${process.pid}.tmp`
    await fs.writeFile(temporary, snapshot)
    await fs.rename(temporary, CACHE_FILE).catch(async () => {
      await fs.rm(CACHE_FILE, { force: true })
      await fs.rename(temporary, CACHE_FILE)
    })
  })
  await persistTail
}

async function buildPackages(targets: Iterable<string>, runtime: Runtime, options: PipelineOptions): Promise<boolean> {
  const targetSet = new Set(targets)
  if (!targetSet.size) return true
  const dependenciesLeft = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const name of targetSet) {
    const pkg = runtime.packagesByName.get(name)
    if (!pkg) continue
    const pending = new Set([...pkg.dependencies].filter((dependency) => targetSet.has(dependency)))
    dependenciesLeft.set(name, pending)
    for (const dependency of pending) {
      const set = dependents.get(dependency) || new Set<string>()
      set.add(name)
      dependents.set(dependency, set)
    }
  }

  const ready = [...dependenciesLeft].filter(([, pending]) => pending.size === 0).map(([name]) => name).sort()
  const startedAt = performance.now()
  let succeeded = 0
  let running = 0
  let failed = false

  await new Promise<void>((resolve) => {
    const complete = (name: string): void => {
      for (const dependent of dependents.get(name) || []) {
        const pending = dependenciesLeft.get(dependent)
        pending?.delete(name)
        if (pending?.size === 0) ready.push(dependent)
      }
    }
    const launch = (): void => {
      while (!failed && ready.length && running < options.concurrency) {
        const name = ready.shift()!
        const pkg = runtime.packagesByName.get(name)
        if (!pkg) {
          complete(name)
          continue
        }
        running++
        log(`› ${name}`)
        const cacheHit = Boolean(runtime.cache.packages[name])
        const fullRebuild = options.force || !cacheHit
        void runCommand(pkg.buildCommand, pkg.directory, runtime, {
          HIRA_FORCE_REBUILD: fullRebuild ? '1' : '0'
        }).then(async (result) => {
          running--
          if (result.code === 0) {
            runtime.cache.packages[name] = { fingerprint: await packageFingerprint(pkg), builtAt: Date.now() }
            await persistCache(runtime)
            succeeded++
            log(`✓ ${name} ${result.durationMs}ms`)
            complete(name)
          } else {
            printCommandFailure(name, result)
            failed = true
          }
          launch()
        })
      }
      if (!running && (!ready.length || failed)) resolve()
    }
    launch()
  })

  if (failed) return false
  log(`[pipeline] ${succeeded} 个包完成，${Math.round(performance.now() - startedAt)}ms`)
  return true
}

async function buildPlugins(runtime: Runtime, force: boolean): Promise<boolean> {
  const currentFingerprint = await pluginFingerprint()
  if (currentFingerprint === null) return true
  const cached = runtime.cache.plugins
  if (!force && cached?.fingerprint === currentFingerprint && await hasPluginOutput()) return true

  log('› plugins')
  const result = await runCommand('node ./scripts/build-plugins.ts', ROOT, runtime)
  if (result.code !== 0) {
    printCommandFailure('plugins', result)
    return false
  }
  runtime.cache.plugins = { fingerprint: currentFingerprint, builtAt: Date.now() }
  await persistCache(runtime)
  log(`✓ plugins ${result.durationMs}ms`)
  return true
}

function expandDependents(seeds: Iterable<string>, packagesByName: Map<string, WorkspacePackage>): Set<string> {
  const result = new Set<string>()
  const queue = [...seeds]
  while (queue.length) {
    const name = queue.shift()!
    if (result.has(name)) continue
    result.add(name)
    for (const dependent of packagesByName.get(name)?.dependents || []) queue.push(dependent)
  }
  return new Set([...result].filter((name) => packagesByName.has(name)))
}

async function prepare(runtime: Runtime, options: PipelineOptions): Promise<void> {
  const dirty = new Set<string>()
  await Promise.all(runtime.packages.map(async (pkg) => {
    const fingerprintChanged = runtime.cache.packages[pkg.name]?.fingerprint !== await packageFingerprint(pkg)
    if (options.force || fingerprintChanged || !await hasBuildOutput(pkg)) dirty.add(pkg.name)
  }))

  const targets = options.force
    ? new Set(runtime.packages.map((pkg) => pkg.name))
    : expandDependents(dirty, runtime.packagesByName)
  const currentPluginFingerprint = await pluginFingerprint()
  const pluginsDirty = currentPluginFingerprint !== null && (
    options.force ||
    runtime.cache.plugins?.fingerprint !== currentPluginFingerprint ||
    !await hasPluginOutput()
  )

  const packagesOk = await buildPackages(targets, runtime, options)
  if (!packagesOk) throw new Error('workspace 包构建失败')
  const pluginsOk = await buildPlugins(runtime, options.force)
  if (!packagesOk || !pluginsOk) throw new Error('workspace 构建失败')
  if (!dirty.size && !pluginsDirty) log('[pipeline] 命中增量缓存')
}

function mapWatchedPath(changedPath: string, runtime: Runtime): string | null {
  const absolute = normalizePath(path.resolve(changedPath))
  const pluginRoot = normalizePath(PLUGIN_SOURCE_DIR)
  if (absolute === pluginRoot || absolute.startsWith(`${pluginRoot}/`)) return '__plugins__'
  if (PLUGIN_TOOL_FILES.some((file) => absolute === normalizePath(file))) return '__plugins__'
  if (APP_SOURCE_WATCH_DIRS.some((dir) => {
    const root = normalizePath(dir)
    return absolute === root || absolute.startsWith(`${root}/`)
  })) return '__app_main__'
  const match = runtime.packages
    .filter((pkg) => absolute.startsWith(`${normalizePath(pkg.directory)}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0]
  return match?.name || null
}

async function startWatch(runtime: Runtime, options: PipelineOptions): Promise<FSWatcher> {
  const watcher = watch([...runtime.packages.map((pkg) => pkg.directory), ...APP_SOURCE_WATCH_DIRS, PLUGIN_SOURCE_DIR, ...PLUGIN_TOOL_FILES], {
    ignoreInitial: true,
    persistent: true,
    ignored: (watchedPath) => /[\\/](?:dist|node_modules|\.cache|\.git)(?:[\\/]|$)/.test(watchedPath),
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 }
  })

  let timer: NodeJS.Timeout | null = null
  let running = false
  const queuedPackages = new Set<string>()
  let queuedPlugins = false
  let queuedAppMain = false

  /**
   * The custom main/page pipeline is outside electron-vite's Rollup dependency
   * graph. Touching its entry makes electron-vite rebuild main, run the serial
   * copy/bundle steps, and restart Electron against the freshly generated files.
   */
  const triggerAppMainRebuild = async (): Promise<void> => {
    const now = new Date()
    await fs.utimes(APP_MAIN_ENTRY, now, now)
  }

  const flush = async (): Promise<void> => {
    timer = null
    if (running) return
    running = true
    while (queuedPackages.size || queuedPlugins || queuedAppMain) {
      const packageSeeds = [...queuedPackages]
      queuedPackages.clear()
      const rebuildPlugins = queuedPlugins
      queuedPlugins = false
      const rebuildAppMain = queuedAppMain
      queuedAppMain = false
      const packageTargets = expandDependents(packageSeeds, runtime.packagesByName)
      try {
        const packagesOk = await buildPackages(packageTargets, runtime, options)
        const pluginsOk = packagesOk && rebuildPlugins ? await buildPlugins(runtime, true) : packagesOk
        if (!packagesOk || !pluginsOk) {
          logError('[pipeline] 增量重建失败，继续监听源码')
          continue
        }
        if (rebuildAppMain || packageSeeds.length || rebuildPlugins) {
          await triggerAppMainRebuild()
        }
      } catch (error) {
        logError(`[pipeline] 增量重建异常：${errorMessage(error)}`)
      }
    }
    running = false
    if (queuedPackages.size || queuedPlugins) void flush()
  }

  watcher.on('all', (_event, changedPath) => {
    const owner = mapWatchedPath(changedPath, runtime)
    if (!owner) return
    if (owner === '__plugins__') queuedPlugins = true
    else if (owner === '__app_main__') queuedAppMain = true
    else queuedPackages.add(owner)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), 45)
  })
  watcher.on('error', (error) => logError(`[pipeline] watcher：${errorMessage(error)}`))
  return watcher
}

async function runElectronVite(runtime: Runtime, args: string[]): Promise<number> {
  const binary = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
  )
  const extra = args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')
  const command = process.platform === 'win32' ? `"${binary}" dev${extra ? ` ${extra}` : ''}` : binary
  const child = spawn(command, process.platform === 'win32' ? [] : ['dev', ...args], {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    windowsHide: false,
    stdio: 'inherit'
  })
  runtime.activeChildren.add(child)
  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      runtime.activeChildren.delete(child)
      resolve(code ?? 1)
    })
  })
}

async function shutdown(runtime: Runtime, watcher: FSWatcher | null): Promise<void> {
  if (watcher) await watcher.close()
  for (const child of runtime.activeChildren) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } else {
        child.kill()
      }
    } catch {
      // The child may already have exited between enumeration and kill.
    }
  }
}

async function main(): Promise<void> {
  const firstArg = process.argv[2]
  const mode = firstArg && !firstArg.startsWith('-') ? firstArg : 'dev'
  const options = parseOptions(process.argv.slice(mode === firstArg ? 3 : 2))
  if (!['dev', 'prepare', 'build'].includes(mode)) throw new Error(`未知模式：${mode}`)
  if (mode === 'dev' && await portInUse(5173)) {
    logError(
      '[pipeline] 无法启动：端口 5173 已被占用，通常表示已有一个 Hira 开发实例在运行。\n' +
      '[pipeline] 请先回到启动它的终端按 Ctrl+C 正常退出，再重新运行 pnpm dev。\n' +
      '[pipeline] 不要并行启动多个开发实例：它们会争用同一 profile、数据库和 Electron 单实例锁。'
    )
    process.exitCode = 1
    return
  }

  const startedAt = performance.now()
  const packages = await discoverPackages()
  assertAcyclic(packages)
  const runtime: Runtime = {
    packages,
    packagesByName: new Map(packages.map((pkg) => [pkg.name, pkg])),
    cache: await loadCache(),
    activeChildren: new Set()
  }
  for (const cachedName of Object.keys(runtime.cache.packages)) {
    if (!runtime.packagesByName.has(cachedName)) delete runtime.cache.packages[cachedName]
  }

  log(`[pipeline] ${packages.length} 个可构建包，并发 ${options.concurrency}`)
  await prepare(runtime, { ...options, force: mode === 'build' || options.force })
  if (mode !== 'dev') return

  log(`[pipeline] 准备完成，${Math.round(performance.now() - startedAt)}ms，启动 electron-vite`)
  const watcher = await startWatch(runtime, options)
  const onSignal = (): void => void shutdown(runtime, watcher)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let exitCode = 0
  try {
    exitCode = await runElectronVite(runtime, options.electronArgs)
  } finally {
    await shutdown(runtime, watcher)
  }
  process.exitCode = exitCode
}

main().catch((error: unknown) => {
  logError(`[pipeline] ${errorMessage(error)}`)
  process.exitCode = 1
})

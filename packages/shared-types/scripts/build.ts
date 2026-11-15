const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { execFileSync }: typeof import('node:child_process') = require('node:child_process')
const { build }: typeof import('esbuild') = require('esbuild')

const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'src')
const distDir = path.join(root, 'dist')

function collect(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collect(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !/\.test\.ts$/.test(entry.name)
      ? [full]
      : []
  })
}

function outputPath(sourceDir: string, distDir: string, outputDir: string, source: string, extension: string): string {
  const relative = path.relative(sourceDir, source).replace(/\.ts$/, '')
  return path.join(distDir, outputDir, `${relative}${extension}`)
}

function pruneUnexpected(directory: string, expected: Set<string>): void {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      pruneUnexpected(full, expected)
      if (!fs.readdirSync(full).length) fs.rmdirSync(full)
      continue
    }
    if (!expected.has(full)) fs.rmSync(full, { force: true })
  }
}

function rewriteRelativeExtensions(dir: string, extension: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      rewriteRelativeExtensions(full, extension)
      continue
    }
    if (!entry.name.endsWith(extension)) continue
    const source = fs.readFileSync(full, 'utf8')
    const output = source.replace(/(?<=['"])((?:\.\.?\/)[^'"]+)\.js(?=['"])/g, `$1${extension}`)
    if (output !== source) fs.writeFileSync(full, output)
  }
}

async function emit(format: 'esm' | 'cjs', outdir: string, extension: '.mjs' | '.cjs'): Promise<void> {
  await build({
    entryPoints: collect(sourceDir),
    outbase: sourceDir,
    outdir,
    outExtension: { '.js': extension },
    bundle: false,
    format,
    platform: 'node',
    target: 'node22',
    logLevel: 'silent'
  })
  rewriteRelativeExtensions(outdir, extension)
}

const buildInfo = path.join(distDir, '.tsbuildinfo')
const forceRebuild = process.env.HIRA_FORCE_REBUILD === '1'
if (forceRebuild) fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })

const sources = collect(sourceDir)
const declarations = new Set(sources.map((source) => outputPath(sourceDir, distDir, 'types', source, '.d.ts')))
const declarationsMissing = [...declarations].some((file) => !fs.existsSync(file))
if (declarationsMissing) fs.rmSync(buildInfo, { force: true })

execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  '-p', path.join(root, 'tsconfig.build.json'),
  '--incremental',
  '--tsBuildInfoFile', buildInfo
], {
  cwd: root,
  stdio: 'inherit'
})

Promise.all([
  emit('esm', path.join(distDir, 'esm'), '.mjs'),
  emit('cjs', path.join(distDir, 'cjs'), '.cjs')
]).then(() => {
  pruneUnexpected(path.join(distDir, 'types'), declarations)
  pruneUnexpected(path.join(distDir, 'esm'), new Set(sources.map((source) => outputPath(sourceDir, distDir, 'esm', source, '.mjs'))))
  pruneUnexpected(path.join(distDir, 'cjs'), new Set(sources.map((source) => outputPath(sourceDir, distDir, 'cjs', source, '.cjs'))))
}).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

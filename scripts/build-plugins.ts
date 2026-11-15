import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, transformSync } from 'esbuild'
import type { OnResolveArgs, PluginBuild } from 'esbuild'
import { errorMessage } from './lib/type-guards.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = path.join(ROOT, 'apps', 'app-main', 'plugins')
const OUTPUT_DIR = path.join(ROOT, 'build', 'plugins')

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(?:ts|mts|cts|js|mjs|cjs)$/i.test(name)
}

function copyAsset(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function transpile(source: string, destination: string, extension: '.cjs' | '.js'): void {
  const code = fs.readFileSync(source, 'utf8')
  const transformed = transformSync(code, {
    loader: 'ts',
    format: extension === '.cjs' ? 'cjs' : 'esm',
    platform: extension === '.cjs' ? 'node' : 'browser',
    target: extension === '.cjs' ? 'node20' : 'chrome128',
    sourcefile: path.relative(ROOT, source),
    sourcemap: false,
    legalComments: 'none'
  })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, transformed.code)
}

async function transpileRenderer(source: string, destination: string): Promise<void> {
  const result = await build({
    entryPoints: [source],
    outfile: destination,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome128',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [{
      name: 'hira-runtime-external',
      setup(builder: PluginBuild) {
        builder.onResolve({ filter: /^hira:\/\// }, (args: OnResolveArgs) => ({ path: args.path, external: true }))
      }
    }]
  })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, result.outputFiles[0].contents)
}

async function buildDirectory(sourceDir: string, outputDir: string): Promise<void> {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (isTestFile(entry.name)) continue
    const source = path.join(sourceDir, entry.name)
    if (entry.isDirectory()) {
      await buildDirectory(source, path.join(outputDir, entry.name))
      continue
    }

    const extension = path.extname(entry.name).toLowerCase()
    if (extension === '.cts') {
      transpile(source, path.join(outputDir, `${path.basename(entry.name, extension)}.cjs`), '.cjs')
    } else if (extension === '.ts') {
      const destination = path.join(outputDir, `${path.basename(entry.name, extension)}.js`)
      if (entry.name.endsWith('.renderer.ts')) await transpileRenderer(source, destination)
      else transpile(source, destination, '.js')
    } else {
      copyAsset(source, path.join(outputDir, entry.name))
    }
  }
}

if (!fs.existsSync(SOURCE_DIR)) throw new Error(`plugin source directory not found: ${SOURCE_DIR}`)
const relativeOutput = path.relative(ROOT, OUTPUT_DIR)
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error(`unsafe plugin output directory: ${OUTPUT_DIR}`)
}

async function main(): Promise<void> {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  await buildDirectory(SOURCE_DIR, OUTPUT_DIR)
  console.log(`[plugins:build] ${path.relative(ROOT, OUTPUT_DIR)}`)
}

main().catch((error: unknown) => {
  console.error('[plugins:build] failed:', errorMessage(error))
  process.exitCode = 1
})

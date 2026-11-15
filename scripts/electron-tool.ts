#!/usr/bin/env node

const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { spawnSync }: typeof import('node:child_process') = require('node:child_process')
const { buildSync }: typeof import('esbuild') = require('esbuild')

const root = path.resolve(__dirname, '..')
const [sourceArg, ...toolArgs] = process.argv.slice(2)

if (!sourceArg) {
  console.error('用法: node scripts/electron-tool.ts <工具.ts> [...参数]')
  process.exit(2)
}

const sourceFile = path.resolve(root, sourceArg)
if (!fs.existsSync(sourceFile)) {
  console.error(`找不到 Electron 工具入口: ${sourceFile}`)
  process.exit(2)
}

const relativeSource = path.relative(root, sourceFile)
const outputFile = path.join(root, '.tmp', 'electron-tools', relativeSource.replace(/\.ts$/i, '.cjs'))
fs.mkdirSync(path.dirname(outputFile), { recursive: true })

buildSync({
  entryPoints: [sourceFile],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external',
  legalComments: 'none',
  logLevel: 'silent',
  define: {
    __filename: JSON.stringify(sourceFile),
    __dirname: JSON.stringify(path.dirname(sourceFile))
  }
})

const env: NodeJS.ProcessEnv = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const electronPath = String(require('electron'))
const result = spawnSync(electronPath, [outputFile, ...toolArgs], {
  cwd: root,
  env,
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exit(result.status ?? 1)

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { asRecord, numberOf, stringOf } from '../../scripts/lib/type-guards'

interface PngImage { width: number; height: number; data: Buffer }
interface PngModule {
  new(options: { width: number; height: number }): PngImage
  sync: { read(buffer: Buffer): PngImage; write(png: PngImage): Buffer }
}
interface SnapshotOptions {
  mainPath: string
  outPngPath: string
  width: number
  height: number
  targetPxW?: number
  targetPxH?: number
  delayMs: number
}

const pixelmatch = (require('pixelmatch') as { default: (a: Buffer, b: Buffer, output: Buffer, width: number, height: number, options?: { threshold?: number }) => number }).default
const { PNG } = require('pngjs') as { PNG: PngModule }

function getArg(name: string, defaultValue: string): string {
  const argv = process.argv.slice(2)
  const pref = `--${name}=`
  const hit = argv.find((a) => a.startsWith(pref))
  if (hit) return hit.slice(pref.length)

  const idx = argv.indexOf(`--${name}`)
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1]

  return defaultValue
}

function toCaseId(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return '001'
  if (/^\d+$/.test(s)) return s.padStart(3, '0')
  return s
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadPng(filePath: string): PngImage {
  return PNG.sync.read(fs.readFileSync(filePath))
}

function writePng(filePath: string, png: PngImage): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, PNG.sync.write(png))
}

function normalizePngToSize(src: PngImage, width: number, height: number): PngImage {
  const out = new PNG({ width, height })
  const copyW = Math.min(width, src.width)
  const copyH = Math.min(height, src.height)

  for (let y = 0; y < copyH; y += 1) {
    const srcStart = (y * src.width) * 4
    const srcEnd = (y * src.width + copyW) * 4
    const outStart = (y * width) * 4
    src.data.copy(out.data, outStart, srcStart, srcEnd)
  }

  return out
}

async function runElectronSnapshot({ mainPath, outPngPath, width, height, targetPxW, targetPxH, delayMs }: SnapshotOptions): Promise<void> {
  const electronPath = require('electron')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(electronPath, [mainPath], {
      env: {
        ...process.env,
        HIRA_APP_ROOT: process.cwd(),
        HIRA_SNAPSHOT: '1',
        HIRA_SNAPSHOT_OUT: outPngPath,
        HIRA_WINDOW_W: String(width),
        HIRA_WINDOW_H: String(height),
        HIRA_TARGET_PX_W: targetPxW ? String(targetPxW) : '',
        HIRA_TARGET_PX_H: targetPxH ? String(targetPxH) : '',
        HIRA_SNAPSHOT_DELAY_MS: String(delayMs)
      },
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`electron exited with code ${code}`))
    })
  })
}

async function main(): Promise<void> {
  const baselineVersion = getArg('baseline', 'v7.5.0')
  const caseId = toCaseId(getArg('case', '001'))
  const threshold = Number(getArg('threshold', '0.1'))
  const passRate = Number(getArg('passRate', '0.95'))
  const delayMs = Number(getArg('delayMs', '1200'))

  const baselineDir = path.join(process.cwd(), 'docs-ng', 'ui-baseline', baselineVersion)
  if (!fs.existsSync(baselineDir)) {
    console.error(`baselineDir not found: ${baselineDir}`)
    process.exit(2)
  }

  const re = new RegExp(`^state-${caseId}-.+\\.png$`)
  const baselinePngs = fs
    .readdirSync(baselineDir)
    .filter((name) => re.test(name))
    .sort()

  if (baselinePngs.length === 0) {
    console.error(`no baseline png for case ${caseId} under ${baselineDir}`)
    process.exit(2)
  }

  const baselinePngName = baselinePngs[0]
  const baselinePngPath = path.join(baselineDir, baselinePngName)
  const baselineJsonPath = baselinePngPath.replace(/\.png$/i, '.json')

  const baseline = loadPng(baselinePngPath)
  const meta = readJsonIfExists(baselineJsonPath)
  const windowSize = asRecord(meta?.windowSize)
  const width = numberOf(windowSize.w, 1100)
  const height = numberOf(windowSize.h, 720)

  const runId = String(Date.now())
  const outputRoot = path.join(process.cwd(), 'tests', 'ui', 'output', runId)
  const actualPngPath = path.join(outputRoot, 'actual', baselinePngName)
  const diffPngPath = path.join(outputRoot, 'diff', baselinePngName)
  const reportPath = path.join(outputRoot, 'report', baselinePngName.replace(/\.png$/i, '.json'))

  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  if (!fs.existsSync(mainPath)) {
    console.error(`main bundle not found: ${mainPath}`)
    console.error('run `pnpm build` first')
    process.exit(2)
  }

  await runElectronSnapshot({
    mainPath,
    outPngPath: actualPngPath,
    width,
    height,
    targetPxW: baseline.width,
    targetPxH: baseline.height,
    delayMs
  })

  if (!fs.existsSync(actualPngPath) || fs.statSync(actualPngPath).size === 0) {
    console.error(`snapshot png missing or empty: ${actualPngPath}`)
    process.exit(2)
  }

  const actual = loadPng(actualPngPath)
  const actualNormalized =
    baseline.width === actual.width && baseline.height === actual.height
      ? actual
      : normalizePngToSize(actual, baseline.width, baseline.height)

  const diff = new PNG({ width: baseline.width, height: baseline.height })
  const diffPixels = pixelmatch(
    baseline.data,
    actualNormalized.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold }
  )

  writePng(diffPngPath, diff)

  const totalPixels = baseline.width * baseline.height
  const mismatchRate = totalPixels === 0 ? 1 : diffPixels / totalPixels
  const matchRate = 1 - mismatchRate

  const report = {
    caseId,
    baselineVersion,
    baselinePngPath,
    baselineJsonPath: fs.existsSync(baselineJsonPath) ? baselineJsonPath : null,
    actualPngPath,
    diffPngPath,
    width: baseline.width,
    height: baseline.height,
    actualWidth: actual.width,
    actualHeight: actual.height,
    threshold,
    diffPixels,
    totalPixels,
    matchRate,
    passRate,
    pass: matchRate >= passRate
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`matchRate=${(matchRate * 100).toFixed(2)}% pass=${report.pass}`)

  process.exit(report.pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

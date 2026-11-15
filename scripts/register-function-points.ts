import * as fs from 'node:fs'
import * as path from 'node:path'
import { asRecord, stringOf } from './lib/type-guards.ts'

interface FunctionPoint {
  id: string
  name: string
  category: string
  source: string
  ng: Record<string, unknown>
  [key: string]: unknown
}

interface CatalogFile {
  functions?: FunctionPoint[]
  [key: string]: unknown
}

type TrackerFile = Record<string, Record<string, unknown>>

const root = path.resolve(__dirname, '..')
const catalogPath = path.join(root, '.hira-ai', 'l1-functions.json')
const trackerPath = path.join(root, '.hira-ai', 'l1-coverage-tracker.json')

const batchPath = process.argv[2]
if (!batchPath) {
  console.error('usage: node scripts/register-function-points.cjs <batch.json>')
  process.exit(2)
}

const batch: unknown = JSON.parse(fs.readFileSync(path.resolve(root, batchPath), 'utf8'))
if (!Array.isArray(batch) || !batch.length) {
  console.error('batch must be a non-empty array')
  process.exit(2)
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogFile
const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8')) as TrackerFile
const functions = Array.isArray(catalog.functions) ? catalog.functions : []

const byId = new Map<string, FunctionPoint>(functions.map((fn) => [fn.id, fn]))
const now = new Date().toISOString()
const applied = []

for (const rawItem of batch) {
  const item = asRecord(rawItem)
  const id = stringOf(item.id).trim()
  const name = stringOf(item.name).trim()
  const category = stringOf(item.category).trim()
  const source = stringOf(item.source).trim()
  const ng = asRecord(item.ng)
  const status = stringOf(item.status, 'covered')
  const providers = Array.isArray(item.providers) ? item.providers : []
  const tests = Array.isArray(item.tests) ? item.tests : []
  if (!id || !name || !category || !source || !Object.keys(ng).length) {
    console.error(`invalid batch entry: ${JSON.stringify(item)}`)
    process.exit(2)
  }
  if (!Object.prototype.hasOwnProperty.call(tracker, id)) {
    console.error(`unknown function id: ${id}`)
    process.exit(2)
  }
  byId.set(id, { id, name, category, source, ng })
  tracker[id] = { ...(tracker[id] || {}), status, providers, tests, updatedAt: now }
  applied.push(id)
}

catalog.functions = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))

fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
fs.writeFileSync(trackerPath, `${JSON.stringify(tracker)}\n`, 'utf8')

console.log(JSON.stringify({ applied: applied.length, ids: applied, catalogSize: catalog.functions.length }, null, 2))

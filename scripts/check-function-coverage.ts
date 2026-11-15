import * as fs from 'node:fs'
import * as path from 'node:path'

interface CoverageEntry {
  status?: string
  providers?: unknown[]
  tests?: unknown[]
  [key: string]: unknown
}

type CoverageTracker = Record<string, CoverageEntry>

interface CatalogSegment {
  category: string
  prefix: string
}

interface CatalogBinding {
  kind: string
  [key: string]: unknown
}

interface CatalogFunction {
  id: string
  name: string
  category: string
  source: string
  ng: CatalogBinding
  [key: string]: unknown
}

interface Catalog {
  totalFunctionPoints?: number
  functions?: CatalogFunction[]
  segments?: CatalogSegment[]
}

type CoverageStatus = 'planned' | 'partial' | 'covered' | 'verified' | 'blocked'

const root = path.resolve(import.meta.dirname, '..')
const trackerPath = path.join(root, '.hira-ai', 'l1-coverage-tracker.json')
const catalogPath = path.join(root, '.hira-ai', 'l1-functions.json')

const VALID_STATUSES = new Set<CoverageStatus>(['planned', 'partial', 'covered', 'verified', 'blocked'])
const COVERED_STATUSES = new Set<CoverageStatus>(['covered', 'verified'])
const REQUIRED_FIELDS = ['id', 'name', 'category', 'source', 'ng']
const BINDING_RULES = {
  provider: ['capability', 'providerId', 'method'],
  'domain-method': ['package', 'method'],
  'service-method': ['package', 'method'],
  'service-field': ['package', 'method', 'field'],
  ipc: ['channel']
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function checkTracker(tracker: CoverageTracker, expectedIds: string[], errors: string[]): Record<CoverageStatus, number> {
  const counts: Record<CoverageStatus, number> = { planned: 0, partial: 0, covered: 0, verified: 0, blocked: 0 }
  for (const id of expectedIds) {
    const entry = tracker[id]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${id}: entry must be an object`)
      continue
    }
    const status = String(entry.status || 'planned') as CoverageStatus
    if (!VALID_STATUSES.has(status)) errors.push(`${id}: unsupported status ${status}`)
    else counts[status] += 1
    if (entry.providers !== undefined && !Array.isArray(entry.providers)) {
      errors.push(`${id}: providers must be an array`)
    }
    if (entry.tests !== undefined && !Array.isArray(entry.tests)) {
      errors.push(`${id}: tests must be an array`)
    }
    if (status === 'verified' && (!entry.providers?.length || !entry.tests?.length)) {
      errors.push(`${id}: verified entries require providers and tests`)
    }
  }
  return counts
}

function checkCatalog(catalog: Catalog, validIds: Set<string>, errors: string[]): { ids: Set<string>; byCategory: Record<string, number> } {
  const functions = Array.isArray(catalog.functions) ? catalog.functions : []
  if (!functions.length) errors.push('catalog.functions must be a non-empty array')

  const segments = Array.isArray(catalog.segments) ? catalog.segments : []
  const prefixByCategory = new Map<string, string>(segments.map((segment: CatalogSegment) => [segment.category, segment.prefix]))

  const ids = new Set<string>()
  const byCategory: Record<string, number> = {}

  for (const fn of functions) {
    const id = fn && fn.id
    if (!id) {
      errors.push('catalog entry missing id')
      continue
    }
    if (ids.has(id)) errors.push(`${id}: duplicate catalog id`)
    ids.add(id)
    if (!validIds.has(id)) errors.push(`${id}: not a valid F-0001..F-1234 id`)

    for (const field of REQUIRED_FIELDS) {
      if (fn[field] === undefined || fn[field] === '') errors.push(`${id}: catalog entry missing ${field}`)
    }

    const prefix = prefixByCategory.get(fn.category)
    if (!prefix) errors.push(`${id}: unknown category ${fn.category}`)
    else if (!id.startsWith(prefix)) errors.push(`${id}: id does not match category ${fn.category} prefix ${prefix}`)

    const binding = fn.ng
    if (!binding || typeof binding !== 'object') {
      errors.push(`${id}: ng binding must be an object`)
    } else {
      const rules = BINDING_RULES[binding.kind as keyof typeof BINDING_RULES]
      if (!rules) errors.push(`${id}: unknown ng.kind ${binding.kind}`)
      else {
        for (const key of rules) {
          if (binding[key] === undefined || binding[key] === '') {
            errors.push(`${id}: ng.${binding.kind} missing ${key}`)
          }
        }
      }
    }

    byCategory[fn.category] = (byCategory[fn.category] || 0) + 1
  }

  return { ids, byCategory }
}

const expected = Array.from({ length: 1234 }, (_, index) => `F-${String(index + 1).padStart(4, '0')}`)
const validIds = new Set(expected)
const errors: string[] = []

const tracker = readJson<CoverageTracker>(trackerPath)
const trackerIds = Object.keys(tracker).sort()
if (trackerIds.length !== expected.length || trackerIds.some((id, index) => id !== expected[index])) {
  errors.push(`tracker must contain exactly F-0001 through F-1234; found ${trackerIds.length} entries`)
}
const counts = checkTracker(tracker, expected, errors)

let identifiedIds = new Set<string>()
let identifiedByCategory: Record<string, number> = {}
if (!fs.existsSync(catalogPath)) {
  errors.push(`catalog not found: ${path.relative(root, catalogPath)}`)
} else {
  const catalog = readJson<Catalog>(catalogPath)
  if (catalog.totalFunctionPoints !== expected.length) {
    errors.push(`catalog.totalFunctionPoints must be ${expected.length}; found ${catalog.totalFunctionPoints}`)
  }
  const catalogResult = checkCatalog(catalog, validIds, errors)
  identifiedIds = catalogResult.ids
  identifiedByCategory = catalogResult.byCategory
}

const covered = counts.covered + counts.verified
const identified = identifiedIds.size
const identifiedCovered = [...identifiedIds].filter((id) => COVERED_STATUSES.has(tracker[id]?.status as CoverageStatus)).length
const percentage = Math.round((covered / expected.length) * 10000) / 100
const identifiedPercentage = identified ? Math.round((identifiedCovered / identified) * 10000) / 100 : 0

const result = {
  total: expected.length,
  covered,
  percentage,
  counts,
  identified,
  identifiedByCategory,
  identifiedCovered,
  identifiedPercentage,
  errors
}
console.log(JSON.stringify(result, null, 2))
if (errors.length || percentage < 100) process.exitCode = 1

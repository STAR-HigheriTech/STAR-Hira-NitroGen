const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const trackerPath = path.join(root, '.hira-ai', 'l1-coverage-tracker.json')
const [id, status, providersArg = '', testsArg = ''] = process.argv.slice(2)
const validStatuses = new Set(['planned', 'partial', 'covered', 'verified', 'blocked'])
const idPattern = /^F-(?:[0-9]{4})$/

if (!idPattern.test(id || '') || !validStatuses.has(status)) {
  console.error('usage: node scripts/set-function-coverage.cjs F-0001 <planned|partial|covered|verified|blocked> [provider,...] [test,...]')
  process.exit(2)
}

const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'))
if (!Object.prototype.hasOwnProperty.call(tracker, id)) {
  console.error(`unknown function id: ${id}`)
  process.exit(2)
}

const providers = providersArg ? providersArg.split(',').map((value) => value.trim()).filter(Boolean) : []
const tests = testsArg ? testsArg.split(',').map((value) => value.trim()).filter(Boolean) : []
const current = tracker[id] && typeof tracker[id] === 'object' ? tracker[id] : {}
tracker[id] = { ...current, status, providers, tests, updatedAt: new Date().toISOString() }
fs.writeFileSync(trackerPath, `${JSON.stringify(tracker)}\n`, 'utf8')
console.log(JSON.stringify({ id, ...tracker[id] }, null, 2))
